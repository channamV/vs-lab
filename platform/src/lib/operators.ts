import { createHash } from "node:crypto";
import { and, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  checkins,
  engineSessions,
  machines,
  machineOperators,
  operators,
  pinFailures,
  checkinPhotos,
} from "@/lib/db/schema";
import { checklistForMachine, evaluateAnswers, recordIssues } from "@/lib/checklists";
import { PHOTO_RULES, photoStorageAvailable, savePhoto, type PhotoFile } from "@/lib/photos";
import { effectiveEnd, type SessionSpan } from "@/lib/telemetry/engine";

/**
 * Operators, machine assignments and QR check-in (Tier 2 — Safety & Access Monitoring).
 * Plain functions that take the database, so they can be tested without a server.
 */

export const PIN_PATTERN = /^\d{4,8}$/;

export const CHECKIN_RULES = {
  /** Wrong PINs allowed per machine within `lockoutMinutes` before the page stops accepting PINs. */
  maxPinFailures: 5,
  lockoutMinutes: 10,
  /** The phone must be within this distance of the machine's last GPS position... */
  maxDistanceM: 100,
  /** ...plus the phone's own accuracy radius, up to this much (phone GPS can be off by tens of metres). */
  maxAccuracyAllowanceM: 150,
  /**
   * After checking in, the operator has this long to start the engine. The check-in is then linked to
   * that engine-on period and ends automatically when the engine stops. No start → checked out.
   */
  engineStartWindowMinutes: 5,
  /**
   * How long a check-in survives the engine being off (a break, refuelling) before the operator is
   * checked out, by check-in method. A restart within this time stays with the same operator.
   * Beacon check-ins need no allowance: the device sees the beacon again when the operator returns.
   */
  breakMinutes: { web: 30, ble: 0 } as Record<string, number>,
};

// ---------- Location check: is the phone near the machine? ----------

export type LocationCheck = "near" | "far" | "no-phone-location" | "no-machine-location";
export type PhoneLocation = { lat: number; lng: number; accuracyM: number };

/** Great-circle distance in metres. */
export function distanceMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/**
 * Compares the phone's position with the machine's last GPS position. Both have cellular + GPS, so
 * being close together is good evidence the operator is at the machine. The machine's position can be
 * hours old (the device goes quiet when parked), which is fine: parked machines don't move.
 */
export function checkLocation(
  phone: PhoneLocation | null | undefined,
  machine: { lat: number | null; lng: number | null },
): { check: LocationCheck; distanceM: number | null } {
  if (!phone) return { check: "no-phone-location", distanceM: null };
  if (machine.lat === null || machine.lng === null) return { check: "no-machine-location", distanceM: null };
  const distanceM = distanceMeters(phone, { lat: machine.lat, lng: machine.lng });
  const allowed = CHECKIN_RULES.maxDistanceM + Math.min(Math.max(phone.accuracyM, 0), CHECKIN_RULES.maxAccuracyAllowanceM);
  return { check: distanceM <= allowed ? "near" : "far", distanceM };
}

// ---------- Check-in lifecycle: one check-in covers one engine-on period ----------
//
// Operators don't check out (in practice they never do). Instead:
//  - check in, then start the engine within the window → the check-in is linked to that engine-on period
//  - the engine stops (or the device goes silent) → the operator is checked out automatically, after a
//    break allowance for web check-ins (a restart within it stays with the same operator)
//  - no start within the window → the operator is checked out automatically ("no start")
//  - engine already running at check-in → linked straight away: a "takeover" if another operator had it,
//    otherwise "already-running" (flagged: the checklist was done after starting)

export type EngineLink = "started" | "already-running" | "takeover";

const windowMs = () => CHECKIN_RULES.engineStartWindowMinutes * 60_000;

/** A session that is still running at `now` (not ended, not gone stale, already started). */
function isLive(s: SessionSpan, now: number): boolean {
  return !s.endedAt && s.startedAt.getTime() <= now && effectiveEnd(s, now) >= now;
}

type OpenCheckin = { startedAt: Date; endedAt: Date | null; engineSessionId: number | null; method?: string };

const breakMs = (c: OpenCheckin) => (CHECKIN_RULES.breakMinutes[c.method ?? "web"] ?? 0) * 60_000;

/** When the linked engine stopped, or null while it's still running. */
export function engineStoppedAt(linked: SessionSpan, now = Date.now()): Date | null {
  return isLive(linked, now) ? null : new Date(effectiveEnd(linked, now));
}

/**
 * When and why an open check-in ends, or null if it still counts at `now`.
 * `linked` is the engine session the check-in is linked to (null if not linked yet).
 * After the engine stops, the check-in survives the break allowance; if it then ends, it's recorded as
 * ending when the engine stopped.
 */
export function automaticEnd(c: OpenCheckin, linked: SessionSpan | null, now = Date.now()): { endedAt: Date; endReason: string } | null {
  if (c.engineSessionId && linked) {
    const stopped = engineStoppedAt(linked, now);
    if (!stopped || now < stopped.getTime() + breakMs(c)) return null;
    return { endedAt: stopped, endReason: "engine stopped" };
  }
  const windowEnd = c.startedAt.getTime() + windowMs();
  return now < windowEnd ? null : { endedAt: new Date(windowEnd), endReason: "no start" };
}

/** Whether a check-in still counts at `now`: not ended, and not due to end automatically. */
export function isCheckinCurrent(c: OpenCheckin, linked: SessionSpan | null, now = Date.now()): boolean {
  return !c.endedAt && automaticEnd(c, linked, now) === null;
}

/**
 * Brings a machine's open check-ins up to date: links a waiting check-in to an engine start within the
 * window, and ends check-ins whose engine stopped or never started. Called on each device report and
 * before check-in / check-out, so the database matches what the pages show.
 */
export async function syncCheckins(db: Db, machineId: number, now = new Date()) {
  const open = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.machineId, machineId), isNull(checkins.endedAt)));
  if (open.length === 0) return;
  const [running] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt)));
  const t = now.getTime();

  const live = running && isLive(running, t) ? running : null;

  for (const c of open) {
    // Waiting for a start: link it if the engine started within the window.
    if (!c.engineSessionId && live && live.startedAt.getTime() <= c.startedAt.getTime() + windowMs()) {
      const engineLink: EngineLink = live.startedAt >= c.startedAt ? "started" : "already-running";
      await db.update(checkins).set({ engineSessionId: live.id, engineLink }).where(eq(checkins.id, c.id));
      continue;
    }
    const [linked] = c.engineSessionId
      ? await db.select().from(engineSessions).where(eq(engineSessions.id, c.engineSessionId))
      : [];
    // On a break: a restart within the allowance stays with this operator.
    const stopped = linked ? engineStoppedAt(linked, t) : null;
    if (live && stopped && live.id !== c.engineSessionId && live.startedAt.getTime() <= stopped.getTime() + breakMs(c)) {
      await db.update(checkins).set({ engineSessionId: live.id }).where(eq(checkins.id, c.id));
      continue;
    }
    const end = automaticEnd(c, linked ?? null, t);
    if (end) await db.update(checkins).set(end).where(eq(checkins.id, c.id));
  }
}

/** What happened with the engine for one check-in, for the history table and flags. */
export type CheckinEngine =
  | { kind: "started"; minutes: number }
  | { kind: "already-running" }
  | { kind: "takeover" }
  /** Checked in, engine not started yet (still inside the window). */
  | { kind: "waiting" }
  /** Engine didn't start within the window, so the operator was checked out. */
  | { kind: "no-start" }
  /** Ended some other way before the engine started (e.g. manual check-out). */
  | { kind: "not-used" };

export function checkinEngine(
  c: OpenCheckin & { engineLink: string | null; endReason: string | null },
  linked: SessionSpan | null,
  now = Date.now(),
): CheckinEngine {
  if (c.engineLink === "already-running" || c.engineLink === "takeover") return { kind: c.engineLink };
  if (c.engineLink === "started" && linked) {
    return { kind: "started", minutes: Math.max(0, Math.round((linked.startedAt.getTime() - c.startedAt.getTime()) / 60_000)) };
  }
  if (!c.endedAt) return automaticEnd(c, linked, now) ? { kind: "no-start" } : { kind: "waiting" };
  return c.endReason === "no start" ? { kind: "no-start" } : { kind: "not-used" };
}

/**
 * PINs are looked up by hash, so the same PIN always gives the same hash (no per-row salt).
 * A 4–8 digit PIN can't be protected by hashing alone; the rate limit is what stops guessing.
 */
export function hashPin(pin: string): string {
  return createHash("sha256").update(`vs-lab-pin-v1:${pin}`).digest("hex");
}

export class OperatorError extends Error {}

function checkPin(pin: string) {
  if (!PIN_PATTERN.test(pin)) throw new OperatorError("PIN must be 4 to 8 digits.");
}

/** PINs only need to be unique within an organization: the machine's QR code tells us which one. */
async function assertPinFree(db: Db, organizationId: number, pin: string, exceptOperatorId?: number) {
  const [taken] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(
      and(
        eq(operators.organizationId, organizationId),
        eq(operators.pinHash, hashPin(pin)),
        exceptOperatorId ? ne(operators.id, exceptOperatorId) : undefined,
      ),
    );
  if (taken) throw new OperatorError("That PIN is already used by another operator. Choose a different one.");
}

/** Employee numbers are optional, and unique within an organization. Names can repeat. */
async function cleanEmployeeNumber(db: Db, organizationId: number, value: string | undefined, exceptOperatorId?: number) {
  const employeeNumber = value?.trim() || null;
  if (!employeeNumber) return null;
  const [taken] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(
      and(
        eq(operators.organizationId, organizationId),
        eq(operators.employeeNumber, employeeNumber),
        exceptOperatorId ? ne(operators.id, exceptOperatorId) : undefined,
      ),
    );
  if (taken) throw new OperatorError(`Employee number ${employeeNumber} is already used by another operator.`);
  return employeeNumber;
}

export async function createOperator(
  db: Db,
  organizationId: number,
  input: { name: string; pin: string; employeeNumber?: string },
) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  checkPin(input.pin);
  await assertPinFree(db, organizationId, input.pin);
  const employeeNumber = await cleanEmployeeNumber(db, organizationId, input.employeeNumber);
  const [row] = await db
    .insert(operators)
    .values({ organizationId, name, employeeNumber, pinHash: hashPin(input.pin) })
    .returning();
  return row;
}

export async function updateOperator(
  db: Db,
  organizationId: number,
  id: number,
  input: { name: string; active: boolean; newPin?: string; employeeNumber?: string },
) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  const [existing] = await db
    .select({ id: operators.id, erasedAt: operators.erasedAt })
    .from(operators)
    .where(and(eq(operators.id, id), eq(operators.organizationId, organizationId)));
  if (!existing) throw new OperatorError("Operator not found.");
  if (existing.erasedAt) throw new OperatorError("This operator's data was erased; add them again as a new operator if needed.");
  const changes: Partial<typeof operators.$inferInsert> = {
    name,
    active: input.active,
    employeeNumber: await cleanEmployeeNumber(db, organizationId, input.employeeNumber, id),
  };
  if (input.newPin) {
    checkPin(input.newPin);
    await assertPinFree(db, organizationId, input.newPin, id);
    changes.pinHash = hashPin(input.newPin);
  }
  await db.update(operators).set(changes).where(eq(operators.id, id));
  // A deactivated operator is checked out everywhere.
  if (!input.active) {
    await db
      .update(checkins)
      .set({ endedAt: new Date(), endReason: "deactivated" })
      .where(and(eq(checkins.operatorId, id), isNull(checkins.endedAt)));
  }
}

/**
 * Replaces the list of operators allowed on a machine. An empty list means any active operator.
 * Returns who was added and removed (for notifications).
 */
export async function setMachineOperators(db: Db, organizationId: number, machineId: number, operatorIds: number[]) {
  const [machine] = await db
    .select({ id: machines.id })
    .from(machines)
    .where(and(eq(machines.id, machineId), eq(machines.organizationId, organizationId)));
  if (!machine) throw new OperatorError("Machine not found.");
  // Only this organization's operators.
  const valid = operatorIds.length
    ? await db
        .select({ id: operators.id })
        .from(operators)
        .where(and(eq(operators.organizationId, organizationId), inArray(operators.id, operatorIds), isNull(operators.erasedAt)))
    : [];
  operatorIds = [...new Set(valid.map((o) => o.id))];
  const before = (
    await db.select({ id: machineOperators.operatorId }).from(machineOperators).where(eq(machineOperators.machineId, machineId))
  ).map((r) => r.id);
  await db.transaction(async (tx) => {
    await tx.delete(machineOperators).where(eq(machineOperators.machineId, machineId));
    if (operatorIds.length) {
      await tx.insert(machineOperators).values(operatorIds.map((operatorId) => ({ machineId, operatorId })));
    }
  });
  return { added: operatorIds.filter((id) => !before.includes(id)), removed: before.filter((id) => !operatorIds.includes(id)) };
}

/** Too many wrong PINs on this machine recently (not the same as a machine locked out for repair). */
async function pinLockedOut(db: Db, machineId: number, now: Date) {
  const since = new Date(now.getTime() - CHECKIN_RULES.lockoutMinutes * 60_000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pinFailures)
    .where(and(eq(pinFailures.machineId, machineId), gte(pinFailures.at, since)));
  return count >= CHECKIN_RULES.maxPinFailures;
}

/** Finds the machine's organization's active operator with this PIN. Wrong PINs are recorded for the rate limit. */
async function operatorForPin(db: Db, organizationId: number, machineId: number, pin: string, now: Date) {
  const [operator] = PIN_PATTERN.test(pin)
    ? await db
        .select()
        .from(operators)
        .where(
          and(eq(operators.organizationId, organizationId), eq(operators.pinHash, hashPin(pin)), eq(operators.active, true)),
        )
    : [];
  if (!operator) await db.insert(pinFailures).values({ machineId, at: now });
  return operator ?? null;
}

export type CheckinFailure =
  | "unknown-machine"
  | "locked"
  | "bad-pin"
  | "incomplete"
  | "note-required"
  | "photo-required"
  | "photo-invalid"
  | "not-confirmed"
  | "machine-locked-out"
  | "not-checked-in";

export type CheckInResult =
  | {
      ok: true;
      checkinId: number;
      operatorName: string;
      authorized: boolean;
      checklistOk: boolean;
      /** Defects reported, e.g. "Seatbelt … (Minor defect)". */
      failedItems: string[];
      /** The operator locked the machine out for repair. */
      lockedOut: boolean;
      location: LocationCheck;
      distanceM: number | null;
      /** True if the engine was already running, so the check-in is linked to it straight away. */
      engineRunning: boolean;
    }
  | { ok: false; reason: CheckinFailure; questions?: string[] };

/**
 * An operator checks in to a machine: PIN plus the machine's pre-start checklist (its own template, or
 * the organization's default). `answers` maps each question id to an answer key from the template's
 * answer set; every question must be answered, and the operator must confirm the template's statement,
 * unless they lock the machine out for repair (allowed after a major defect). Defects become issues on
 * the machine (repeats stack). A locked-out machine can't be checked in to until a manager clears it.
 * Ends any open check-in on this machine (replaced) and the operator's open check-in elsewhere (moved).
 * The check-in then follows the engine: see syncCheckins().
 */
export async function checkIn(
  db: Db,
  input: {
    /** The machine's code, from its QR sticker. */
    machineCode: string;
    pin: string;
    answers: Record<string, string | undefined>;
    /** Notes per question (shown for defects). */
    answerNotes?: Record<string, string | undefined>;
    notes?: string;
    /** The operator agreed to the confirmation statement ("I confirm that it's safe to use"). */
    confirmed: boolean;
    /** After a major defect: lock the machine out for repair. */
    lockout?: boolean;
    /** Photos attached to checklist questions (already shrunk by the phone). */
    photos?: PhotoFile[];
    phoneLocation?: PhoneLocation | null;
  },
  now = new Date(),
): Promise<CheckInResult> {
  const [machine] = await db
    .select({
      id: machines.id,
      organizationId: machines.organizationId,
      lat: machines.lastLat,
      lng: machines.lastLng,
      checklistTemplateId: machines.checklistTemplateId,
      lockedOutAt: machines.lockedOutAt,
    })
    .from(machines)
    .where(eq(machines.code, input.machineCode));
  if (!machine) return { ok: false, reason: "unknown-machine" };
  if (machine.lockedOutAt) return { ok: false, reason: "machine-locked-out" };
  const organizationId = machine.organizationId;
  if (await pinLockedOut(db, machine.id, now)) return { ok: false, reason: "locked" };

  const operator = await operatorForPin(db, organizationId, machine.id, input.pin, now);
  if (!operator) return { ok: false, reason: "bad-pin" };

  const { template, options } = await checklistForMachine(db, machine);
  // Photos: only for this checklist's questions, a few per question, real images of a sensible size.
  const photos = input.photos ?? [];
  const questionIds = new Set(template.sections.flatMap((sec) => sec.questions.map((q) => q.id)));
  const photoCounts: Record<string, number> = {};
  for (const p of photos) photoCounts[p.questionId] = (photoCounts[p.questionId] ?? 0) + 1;
  const totalBytes = photos.reduce((n, p) => n + p.data.byteLength, 0);
  if (
    photos.some((p) => !questionIds.has(p.questionId) || !PHOTO_RULES.types.includes(p.contentType) || p.data.byteLength > PHOTO_RULES.maxBytes) ||
    Object.values(photoCounts).some((n) => n > PHOTO_RULES.maxPerQuestion) ||
    totalBytes > PHOTO_RULES.maxTotalBytes ||
    (photos.length > 0 && !photoStorageAvailable())
  ) {
    return { ok: false, reason: "photo-invalid" };
  }
  const evaluation = evaluateAnswers(template.sections, options, {
    answers: input.answers,
    notes: input.answerNotes,
    photoCounts,
    enforcePhotos: photoStorageAvailable(),
  });
  if (!evaluation.ok) return { ok: false, reason: evaluation.reason, questions: evaluation.questions };
  const { answers, defects } = evaluation;
  const lockout = Boolean(input.lockout) && evaluation.hasMajor;
  if (!lockout && !input.confirmed) return { ok: false, reason: "not-confirmed" };
  const failedItems = defects.map((d) => `${d.question} (${d.answerLabel})`);
  // Store the photos before saving the check-in (a failed upload then doesn't leave a check-in without them).
  const stored = await Promise.all(
    photos.map(async (p) => ({ ...p, storageKey: await savePhoto(organizationId, p) })),
  );

  const allowed = await db
    .select({ operatorId: machineOperators.operatorId })
    .from(machineOperators)
    .where(eq(machineOperators.machineId, machine.id));
  const authorized = allowed.length === 0 || allowed.some((a) => a.operatorId === operator.id);
  const phone = input.phoneLocation ?? null;
  const location = checkLocation(phone, machine);

  // Engine already running? Link to it now: a takeover if another operator had it.
  await syncCheckins(db, machine.id, now);
  const [running] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machine.id), isNull(engineSessions.endedAt)));
  // A machine being locked out isn't taken into use, so the check-in isn't linked to a running engine.
  const live = running && isLive(running, now.getTime()) && !lockout ? running : null;
  const [previous] = live
    ? await db
        .select({ engineSessionId: checkins.engineSessionId })
        .from(checkins)
        .where(and(eq(checkins.machineId, machine.id), isNull(checkins.endedAt)))
    : [];
  const engineLink: EngineLink | null = live ? (previous?.engineSessionId === live.id ? "takeover" : "already-running") : null;

  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "replaced" })
      .where(and(eq(checkins.machineId, machine.id), isNull(checkins.endedAt)));
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "moved" })
      .where(and(eq(checkins.operatorId, operator.id), isNull(checkins.endedAt)));
    const [row] = await tx
      .insert(checkins)
      .values({
        organizationId,
        machineId: machine.id,
        operatorId: operator.id,
        startedAt: now,
        // Locking out ends the check-in straight away: nobody operates a locked-out machine.
        ...(lockout && { endedAt: now, endReason: "locked out" }),
        authorized,
        checklistOk: defects.length === 0,
        answers,
        templateName: template.name,
        confirmationText: lockout ? null : template.confirmationText,
        lockoutRequested: lockout,
        notes: input.notes?.trim() || null,
        phoneLat: phone?.lat ?? null,
        phoneLng: phone?.lng ?? null,
        phoneAccuracyM: phone?.accuracyM ?? null,
        distanceM: location.distanceM,
        locationCheck: location.check,
        engineSessionId: live?.id ?? null,
        engineLink,
        method: "web",
      })
      .returning({ id: checkins.id });
    if (stored.length) {
      await tx.insert(checkinPhotos).values(
        stored.map((p) => ({
          organizationId,
          machineId: machine.id,
          checkinId: row.id,
          questionId: p.questionId,
          storageKey: p.storageKey,
          contentType: p.contentType,
          bytes: p.data.byteLength,
          takenAt: now,
        })),
      );
    }
    await recordIssues(tx, { organizationId, machineId: machine.id, checkinId: row.id, defects, now });
    if (lockout) {
      const major = defects.filter((d) => d.severity === "major").map((d) => d.question);
      await tx
        .update(machines)
        .set({ lockedOutAt: now, lockedOutReason: `${operator.name} reported: ${major.join("; ")}`, lockedOutCheckinId: row.id })
        .where(eq(machines.id, machine.id));
    }
    return [row];
  });

  return {
    ok: true,
    checkinId: inserted[0].id,
    operatorName: operator.name,
    authorized,
    checklistOk: defects.length === 0,
    failedItems,
    lockedOut: lockout,
    location: location.check,
    distanceM: location.distanceM,
    engineRunning: live !== null,
  };
}

/**
 * Ends the open check-in on a machine. Optional: check-ins end by themselves when the engine stops.
 * The PIN must belong to the operator who is checked in.
 */
export async function checkOut(
  db: Db,
  input: { machineCode: string; pin: string },
  now = new Date(),
): Promise<{ ok: true; operatorName: string } | { ok: false; reason: CheckinFailure }> {
  const [machine] = await db
    .select({ id: machines.id, organizationId: machines.organizationId })
    .from(machines)
    .where(eq(machines.code, input.machineCode));
  if (!machine) return { ok: false, reason: "unknown-machine" };
  if (await pinLockedOut(db, machine.id, now)) return { ok: false, reason: "locked" };
  await syncCheckins(db, machine.id, now);
  const [open] = await db
    .select({ id: checkins.id, operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.machineId, machine.id), isNull(checkins.endedAt)));
  if (!open) return { ok: false, reason: "not-checked-in" };

  const operator = await operatorForPin(db, machine.organizationId, machine.id, input.pin, now);
  if (!operator || operator.id !== open.operatorId) {
    if (operator) await db.insert(pinFailures).values({ machineId: machine.id, at: now });
    return { ok: false, reason: "bad-pin" };
  }
  await db.update(checkins).set({ endedAt: now, endReason: "checkout" }).where(eq(checkins.id, open.id));
  return { ok: true, operatorName: operator.name };
}

/** A fleet manager ends a check-in from the machine page. */
export async function endCheckin(db: Db, organizationId: number, checkinId: number, now = new Date()) {
  await db
    .update(checkins)
    .set({ endedAt: now, endReason: "ended by manager" })
    .where(and(eq(checkins.id, checkinId), eq(checkins.organizationId, organizationId), isNull(checkins.endedAt)));
}
