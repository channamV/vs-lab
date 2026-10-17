import { createHash } from "node:crypto";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  checkins,
  devices,
  engineSessions,
  machineOperators,
  operators,
  pinFailures,
  type ChecklistAnswer,
} from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";
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
export async function syncCheckins(db: Db, deviceId: string, now = new Date()) {
  const open = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.deviceId, deviceId), isNull(checkins.endedAt)));
  if (open.length === 0) return;
  const [running] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.deviceId, deviceId), isNull(engineSessions.endedAt)));
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

async function assertPinFree(db: Db, pin: string, exceptOperatorId?: number) {
  const [taken] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.pinHash, hashPin(pin)), exceptOperatorId ? ne(operators.id, exceptOperatorId) : undefined));
  if (taken) throw new OperatorError("That PIN is already used by another operator. Choose a different one.");
}

export async function createOperator(db: Db, input: { name: string; pin: string }) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  checkPin(input.pin);
  await assertPinFree(db, input.pin);
  const [row] = await db.insert(operators).values({ name, pinHash: hashPin(input.pin) }).returning();
  return row;
}

export async function updateOperator(db: Db, id: number, input: { name: string; active: boolean; newPin?: string }) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  const changes: Partial<typeof operators.$inferInsert> = { name, active: input.active };
  if (input.newPin) {
    checkPin(input.newPin);
    await assertPinFree(db, input.newPin, id);
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

/** Replaces the list of operators allowed on a machine. An empty list means any active operator. */
export async function setMachineOperators(db: Db, deviceId: string, operatorIds: number[]) {
  await db.transaction(async (tx) => {
    await tx.delete(machineOperators).where(eq(machineOperators.deviceId, deviceId));
    if (operatorIds.length) {
      await tx.insert(machineOperators).values([...new Set(operatorIds)].map((operatorId) => ({ deviceId, operatorId })));
    }
  });
}

async function isLockedOut(db: Db, deviceId: string, now: Date) {
  const since = new Date(now.getTime() - CHECKIN_RULES.lockoutMinutes * 60_000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pinFailures)
    .where(and(eq(pinFailures.deviceId, deviceId), gte(pinFailures.at, since)));
  return count >= CHECKIN_RULES.maxPinFailures;
}

/** Finds the active operator with this PIN. Wrong PINs are recorded for the rate limit. */
async function operatorForPin(db: Db, deviceId: string, pin: string, now: Date) {
  const [operator] = PIN_PATTERN.test(pin)
    ? await db
        .select()
        .from(operators)
        .where(and(eq(operators.pinHash, hashPin(pin)), eq(operators.active, true)))
    : [];
  if (!operator) await db.insert(pinFailures).values({ deviceId, at: now });
  return operator ?? null;
}

export type CheckinFailure = "unknown-machine" | "locked" | "bad-pin" | "incomplete" | "not-checked-in";

export type CheckInResult =
  | {
      ok: true;
      checkinId: number;
      operatorName: string;
      authorized: boolean;
      checklistOk: boolean;
      failedItems: string[];
      location: LocationCheck;
      distanceM: number | null;
      /** True if the engine was already running, so the check-in is linked to it straight away. */
      engineRunning: boolean;
    }
  | { ok: false; reason: CheckinFailure };

/**
 * An operator checks in to a machine: PIN plus the pre-start checklist.
 * `answers` maps each checklist item id to true (OK) or false (not OK); every item must be answered.
 * Ends any open check-in on this machine (replaced) and the operator's open check-in elsewhere (moved).
 * The check-in then follows the engine: see syncCheckins().
 */
export async function checkIn(
  db: Db,
  input: {
    deviceId: string;
    pin: string;
    answers: Record<string, boolean | undefined>;
    notes?: string;
    phoneLocation?: PhoneLocation | null;
  },
  now = new Date(),
): Promise<CheckInResult> {
  const [device] = await db
    .select({ id: devices.id, lat: devices.lastLat, lng: devices.lastLng })
    .from(devices)
    .where(eq(devices.id, input.deviceId));
  if (!device) return { ok: false, reason: "unknown-machine" };
  if (await isLockedOut(db, device.id, now)) return { ok: false, reason: "locked" };

  const operator = await operatorForPin(db, device.id, input.pin, now);
  if (!operator) return { ok: false, reason: "bad-pin" };

  if (CHECKLIST.some((item) => typeof input.answers[item.id] !== "boolean")) return { ok: false, reason: "incomplete" };
  const answers: ChecklistAnswer[] = CHECKLIST.map((item) => ({ id: item.id, question: item.question, ok: input.answers[item.id]! }));
  const failedItems = answers.filter((a) => !a.ok).map((a) => a.question);

  const allowed = await db
    .select({ operatorId: machineOperators.operatorId })
    .from(machineOperators)
    .where(eq(machineOperators.deviceId, device.id));
  const authorized = allowed.length === 0 || allowed.some((a) => a.operatorId === operator.id);
  const phone = input.phoneLocation ?? null;
  const location = checkLocation(phone, device);

  // Engine already running? Link to it now: a takeover if another operator had it.
  await syncCheckins(db, device.id, now);
  const [running] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.deviceId, device.id), isNull(engineSessions.endedAt)));
  const live = running && isLive(running, now.getTime()) ? running : null;
  const [previous] = live
    ? await db
        .select({ engineSessionId: checkins.engineSessionId })
        .from(checkins)
        .where(and(eq(checkins.deviceId, device.id), isNull(checkins.endedAt)))
    : [];
  const engineLink: EngineLink | null = live ? (previous?.engineSessionId === live.id ? "takeover" : "already-running") : null;

  const inserted = await db.transaction(async (tx) => {
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "replaced" })
      .where(and(eq(checkins.deviceId, device.id), isNull(checkins.endedAt)));
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "moved" })
      .where(and(eq(checkins.operatorId, operator.id), isNull(checkins.endedAt)));
    return tx
      .insert(checkins)
      .values({
        deviceId: device.id,
        operatorId: operator.id,
        startedAt: now,
        authorized,
        checklistOk: failedItems.length === 0,
        answers,
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
  });

  return {
    ok: true,
    checkinId: inserted[0].id,
    operatorName: operator.name,
    authorized,
    checklistOk: failedItems.length === 0,
    failedItems,
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
  input: { deviceId: string; pin: string },
  now = new Date(),
): Promise<{ ok: true; operatorName: string } | { ok: false; reason: CheckinFailure }> {
  if (await isLockedOut(db, input.deviceId, now)) return { ok: false, reason: "locked" };
  await syncCheckins(db, input.deviceId, now);
  const [open] = await db
    .select({ id: checkins.id, operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.deviceId, input.deviceId), isNull(checkins.endedAt)));
  if (!open) return { ok: false, reason: "not-checked-in" };

  const operator = await operatorForPin(db, input.deviceId, input.pin, now);
  if (!operator || operator.id !== open.operatorId) {
    if (operator) await db.insert(pinFailures).values({ deviceId: input.deviceId, at: now });
    return { ok: false, reason: "bad-pin" };
  }
  await db.update(checkins).set({ endedAt: now, endReason: "checkout" }).where(eq(checkins.id, open.id));
  return { ok: true, operatorName: operator.name };
}

/** A fleet manager ends a check-in from the machine page. */
export async function endCheckin(db: Db, checkinId: number, now = new Date()) {
  await db
    .update(checkins)
    .set({ endedAt: now, endReason: "ended by manager" })
    .where(and(eq(checkins.id, checkinId), isNull(checkins.endedAt)));
}
