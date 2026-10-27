import { createHash, randomBytes, randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  checkins,
  deviceAssignments,
  machineOperators,
  machines,
  maintenanceIssues,
  operatorAppSessions,
  operatorLoginCodes,
  operators,
  organizations,
  type Machine,
} from "@/lib/db/schema";
import { checklistForMachine, coveringChecklist } from "@/lib/checklists";
import { deviceKey, sessionKey, unlockSignature } from "@/lib/commands";
import { clockTime, machineLabel } from "@/lib/format";
import { machineReadings, meterKindFor } from "@/lib/meters";
import { effectiveMode } from "@/lib/modes";
import { syncCheckins } from "@/lib/operators";
import { orgTimeZone } from "@/lib/org-time";
import { photoStorageAvailable } from "@/lib/photos";
import { placeName } from "@/lib/places";
import { scheduledAccess } from "@/lib/schedules";
import { trainingAccess } from "@/lib/training";

/**
 * The operator app (docs/operator-app.md; Craig 2026-10-26): Android/iPhone app for operators, replacing the production
 * app's flow with VS-lab's check-ins and checklists. Operators sign in with a one-time code emailed to the address on
 * their operator page (no passwords); each sign-in is a long-lived token for that phone (only its hash is stored).
 * On Safety & Access Control machines the app unlocks the starter over Bluetooth with a signed, short-lived pass
 * the device checks with its own key, so it works without signal at the machine.
 */

export const APP_RULES = {
  codeMinutes: 10,
  maxCodesPerHour: 5,
  maxAttempts: 5,
  sessionDays: 90,
  /** A pass from a check-in just made (the app writes it to the device straight away). */
  unlockMinutes: 10,
  /** Offline passes: let the operator start without signal, after doing the checklist in the app. */
  offlinePassHours: 12,
  /** Session hold: the phone's session key for a check-in works for at most this long after checking in (a long shift). */
  sessionHours: 16,
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const normalize = (email: string) => email.trim().toLowerCase();

/** The name a relay device advertises over Bluetooth (the app finds the machine's device by it). */
export const bluetoothName = (deviceId: string) => `VS-${deviceId}`;

// ---------- Sign-in ----------

/**
 * Emails a 6-digit code to an operator's address. Returns the code (for the email) or null when no active operator
 * has that address or too many codes were asked for; the app shows the same message either way.
 */
export async function requestLoginCode(db: Db, rawEmail: string, now = new Date()): Promise<string | null> {
  const email = normalize(rawEmail);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const [known] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(sql`lower(${operators.email}) = ${email}`, eq(operators.active, true), isNull(operators.erasedAt)))
    .limit(1);
  if (!known) return null;
  const [{ n }] = await db
    .select({ n: count() })
    .from(operatorLoginCodes)
    .where(and(eq(operatorLoginCodes.email, email), gte(operatorLoginCodes.createdAt, new Date(now.getTime() - 3_600_000))));
  if (n >= APP_RULES.maxCodesPerHour) return null;
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await db.insert(operatorLoginCodes).values({
    email,
    codeHash: hash(`${email}:${code}`),
    createdAt: now,
    expiresAt: new Date(now.getTime() + APP_RULES.codeMinutes * 60_000),
  });
  return code;
}

export function loginCodeEmail(code: string) {
  return {
    subject: `${code} is your VS Lab code`,
    text: [
      `Your VS Lab sign-in code is ${code}`,
      "",
      `Enter it in the VS Lab app. It works once, for ${APP_RULES.codeMinutes} minutes. If you didn't ask for it, ignore this email.`,
      "",
      "— VS Lab",
    ].join("\n"),
  };
}

export type AppAccount = { token: string; operatorId: number; operatorName: string; organizationName: string };

/**
 * Checks a code. Right → one sign-in per company the address is an operator in (usually one). Wrong → null; after
 * APP_RULES.maxAttempts wrong tries the code stops working.
 */
export async function verifyLoginCode(db: Db, rawEmail: string, code: string, deviceName: string | null, now = new Date()): Promise<AppAccount[] | null> {
  const email = normalize(rawEmail);
  const [latest] = await db
    .select()
    .from(operatorLoginCodes)
    .where(and(eq(operatorLoginCodes.email, email), isNull(operatorLoginCodes.usedAt), gt(operatorLoginCodes.expiresAt, now)))
    .orderBy(desc(operatorLoginCodes.createdAt))
    .limit(1);
  if (!latest || latest.attempts >= APP_RULES.maxAttempts) return null;
  if (latest.codeHash !== hash(`${email}:${code.trim()}`)) {
    await db.update(operatorLoginCodes).set({ attempts: latest.attempts + 1 }).where(eq(operatorLoginCodes.id, latest.id));
    return null;
  }
  await db.update(operatorLoginCodes).set({ usedAt: now }).where(eq(operatorLoginCodes.id, latest.id));
  const ops = await db
    .select({ id: operators.id, name: operators.name, organizationId: operators.organizationId, organizationName: organizations.name })
    .from(operators)
    .innerJoin(organizations, eq(organizations.id, operators.organizationId))
    .where(and(sql`lower(${operators.email}) = ${email}`, eq(operators.active, true), isNull(operators.erasedAt)))
    .orderBy(asc(organizations.name));
  const accounts: AppAccount[] = [];
  for (const op of ops) {
    const token = randomBytes(32).toString("base64url");
    await db.insert(operatorAppSessions).values({
      organizationId: op.organizationId,
      operatorId: op.id,
      tokenHash: hash(token),
      deviceName: deviceName?.slice(0, 80) || null,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: new Date(now.getTime() + APP_RULES.sessionDays * 86_400_000),
    });
    accounts.push({ token, operatorId: op.id, operatorName: op.name, organizationName: op.organizationName });
  }
  return accounts;
}

export type AppAuth = { sessionId: number; operatorId: number; organizationId: number; operatorName: string };

/** The signed-in operator for an app request (`Authorization: Bearer <token>`), or null. */
export async function appAuth(db: Db, header: string | null, now = new Date()): Promise<AppAuth | null> {
  const token = header?.match(/^Bearer (\S+)$/)?.[1];
  if (!token) return null;
  const [row] = await db
    .select({ session: operatorAppSessions, name: operators.name })
    .from(operatorAppSessions)
    .innerJoin(operators, eq(operators.id, operatorAppSessions.operatorId))
    .where(and(eq(operatorAppSessions.tokenHash, hash(token)), gt(operatorAppSessions.expiresAt, now), eq(operators.active, true), isNull(operators.erasedAt)));
  if (!row) return null;
  // Using the app keeps it signed in (rolling 90 days); recorded at most every few minutes.
  if (now.getTime() - row.session.lastSeenAt.getTime() > 5 * 60_000) {
    await db
      .update(operatorAppSessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + APP_RULES.sessionDays * 86_400_000) })
      .where(eq(operatorAppSessions.id, row.session.id));
  }
  return { sessionId: row.session.id, operatorId: row.session.operatorId, organizationId: row.session.organizationId, operatorName: row.name };
}

export async function signOutApp(db: Db, auth: AppAuth) {
  await db.delete(operatorAppSessions).where(eq(operatorAppSessions.id, auth.sessionId));
}

// ---------- What the operator sees ----------

/** Whether this operator may run this machine: approved (or no approval list), by schedule, or by a certification; and holds required training. */
async function operatorAccess(db: Db, m: Pick<Machine, "id" | "organizationId" | "categoryId">, operatorId: number, now: Date) {
  const [approved, scheduled, training] = await Promise.all([
    db.select({ operatorId: machineOperators.operatorId }).from(machineOperators).where(eq(machineOperators.machineId, m.id)),
    scheduledAccess(db, m.organizationId, m.id, now),
    trainingAccess(db, m.organizationId, m, operatorId, now),
  ]);
  const approvedNow = approved.length === 0 || approved.some((a) => a.operatorId === operatorId) || scheduled.includes(operatorId) || training.granted;
  return { approved: approvedNow, trainingMissing: training.missing };
}

/**
 * The operator's machines: those they're approved for (or that accept anyone), with what the app needs to show and
 * to unlock them: mode, lockout, whether today's checklist is done, who's on it, open defects, the relay device.
 */
export async function appMachines(db: Db, auth: AppAuth, now = new Date()) {
  const tz = await orgTimeZone(db, auth.organizationId);
  const rows = await db
    .select({ machine: machines, deviceId: deviceAssignments.deviceId })
    .from(machines)
    .leftJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(and(eq(machines.organizationId, auth.organizationId), sql`${machines.tier} <> 'gps'`))
    .orderBy(asc(machines.name));
  const ids = rows.map((r) => r.machine.id);
  const [openIssues, current] = await Promise.all([
    ids.length
      ? db
          .select({ machineId: maintenanceIssues.machineId, n: count() })
          .from(maintenanceIssues)
          .where(and(inArray(maintenanceIssues.machineId, ids), isNull(maintenanceIssues.resolvedAt)))
          .groupBy(maintenanceIssues.machineId)
      : [],
    ids.length
      ? db
          .select({ machineId: checkins.machineId, operatorId: checkins.operatorId, name: operators.name })
          .from(checkins)
          .innerJoin(operators, eq(operators.id, checkins.operatorId))
          .where(and(inArray(checkins.machineId, ids), isNull(checkins.endedAt)))
      : [],
  ]);
  const out = [];
  for (const { machine: m, deviceId } of rows) {
    const access = await operatorAccess(db, m, auth.operatorId, now);
    if (!access.approved) continue;
    const { template } = await checklistForMachine(db, m);
    const done = await coveringChecklist(db, { machineId: m.id, operatorId: auth.operatorId, frequency: template.frequency, timeZone: tz, now });
    const on = current.find((c) => c.machineId === m.id);
    const relay = m.tier === "control" && deviceId !== null;
    out.push({
      id: m.id,
      code: m.code,
      label: machineLabel(m),
      tier: m.tier,
      mode: effectiveMode(m, now.getTime()).mode,
      lockedOut: m.lockedOutAt !== null,
      trainingMissing: access.trainingMissing,
      checklist: { frequency: template.frequency, doneTodayAt: done ? clockTime(done.startedAt, tz, now.getTime()) : null },
      currentOperator: on ? { name: on.name, isMe: on.operatorId === auth.operatorId } : null,
      openIssues: Number(openIssues.find((i) => i.machineId === m.id)?.n ?? 0),
      relay: relay ? { deviceId: deviceId!, bluetoothName: bluetoothName(deviceId!) } : null,
    });
  }
  return out;
}

/** A machine's checklist for the app (the same as the QR page shows), or null if it isn't theirs to use. */
export async function appChecklist(db: Db, auth: AppAuth, code: string, now = new Date()) {
  const [m] = await db
    .select()
    .from(machines)
    .where(and(eq(machines.code, code), eq(machines.organizationId, auth.organizationId)));
  if (!m) return null;
  const { template, options } = await checklistForMachine(db, m);
  const tz = await orgTimeZone(db, auth.organizationId);
  const done = await coveringChecklist(db, { machineId: m.id, operatorId: auth.operatorId, frequency: template.frequency, timeZone: tz, now });
  const kind = meterKindFor(m);
  const reading = (await machineReadings(db, m.id, now))[kind];
  const placeIds = template.sections.flatMap((s) => s.questions).filter((q) => q.textOnly && (q.prefill === "place" || q.id === "location")).map((q) => q.id);
  return {
    machine: { id: m.id, code: m.code, label: machineLabel(m), onRoad: m.onRoad },
    checklist: {
      name: template.name,
      sections: template.sections,
      options,
      confirmationText: template.confirmationText,
      frequency: template.frequency,
      doneTodayAt: done ? clockTime(done.startedAt, tz, now.getTime()) : null,
      photosEnabled: photoStorageAvailable(),
      meter: { kind, value: reading?.source === "engine" ? reading.value : null, hint: reading && reading.source !== "engine" ? reading.value : null },
      placeQuestionIds: placeIds,
      place: placeIds.length && m.lastLat !== null && m.lastLng !== null ? await placeName(db, m.lastLat, m.lastLng, now) : null,
    },
  };
}

// ---------- Unlock passes (Safety & Access Control) ----------

/**
 * A pass the app writes to the relay device over Bluetooth (pure apart from the key): `U1|<operator>|<check-in or
 * 0>|<from>|<until>|<signature>` (unix seconds). The device checks the signature with its own key and the time
 * window against its GPS clock, then closes the relay as for an ALLOW. "-" signature when signing is off (testing).
 */
export function unlockPass(deviceId: string, operatorId: number, checkinId: number, from: Date, until: Date) {
  const f = Math.floor(from.getTime() / 1000);
  const u = Math.floor(until.getTime() / 1000);
  const key = deviceKey(deviceId);
  return `U1|${operatorId}|${checkinId}|${f}|${u}|${key ? unlockSignature(key, deviceId, operatorId, checkinId, f, u) : "-"}`;
}

/**
 * Session hold (docs/operator-app.md): what the phone keeps for a held check-in so it can resume it after a break.
 * The device works the key out itself from its own key and the other fields; the phone never sends the key, only
 * a proof for the device's random challenge (`resumeProof`). Key "-" = signing is off.
 */
export type AppSession = { checkinId: number; operatorId: number; until: number; holdMinutes: number; key: string };

export function appSession(deviceId: string, c: { id: number; operatorId: number; startedAt: Date; holdMinutes: number | null }): AppSession | null {
  if (!c.holdMinutes) return null;
  const until = Math.floor(c.startedAt.getTime() / 1000) + APP_RULES.sessionHours * 3600;
  const key = deviceKey(deviceId);
  return { checkinId: c.id, operatorId: c.operatorId, until, holdMinutes: c.holdMinutes, key: key ? sessionKey(key, deviceId, c.operatorId, c.id, until, c.holdMinutes) : "-" };
}

/** After a check-in in the app: the pass to hand the machine now (relay machines, approved, Access-Controlled). */
export async function passForCheckin(db: Db, checkinId: number, now = new Date()) {
  const [row] = await db
    .select({ checkin: checkins, machine: machines, deviceId: deviceAssignments.deviceId })
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(eq(checkins.id, checkinId));
  if (!row) return null;
  const { checkin: c, machine: m } = row;
  if (m.tier !== "control" || effectiveMode(m, now.getTime()).mode !== "access_controlled" || !c.authorized || c.lockoutRequested || c.endedAt) return null;
  return {
    deviceId: row.deviceId,
    bluetoothName: bluetoothName(row.deviceId),
    pass: unlockPass(row.deviceId, c.operatorId, c.id, now, new Date(now.getTime() + APP_RULES.unlockMinutes * 60_000)),
    session: appSession(row.deviceId, c),
  };
}

/**
 * The operator's held check-ins that are still current (so the app can resume them after a break), with the session
 * key; the app forgets sessions that aren't listed. At most one per machine.
 */
export async function appSessions(db: Db, auth: AppAuth, now = new Date()) {
  const open = await db
    .select({ checkin: checkins, code: machines.code, deviceId: deviceAssignments.deviceId })
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(and(eq(checkins.operatorId, auth.operatorId), eq(checkins.organizationId, auth.organizationId), isNull(checkins.endedAt), sql`${checkins.holdMinutes} > 0`));
  const out = [];
  for (const { checkin, code, deviceId } of open) {
    // Ended by the rules since (the hold ran out, never started)?
    await syncCheckins(db, checkin.machineId, now);
    const [c] = await db.select().from(checkins).where(eq(checkins.id, checkin.id));
    if (!c || c.endedAt) continue;
    const session = appSession(deviceId, c);
    if (session && session.until * 1000 > now.getTime()) out.push({ machineCode: code, deviceId, bluetoothName: bluetoothName(deviceId), session });
  }
  return out;
}

/**
 * Passes for starting without signal: one per relay machine the operator may start right now (approved, trained, not
 * locked or locked out). The app only uses one after the operator does the checklist (if due); the check-in is
 * uploaded when the phone has signal again, and the device reports the start too.
 */
export async function offlinePasses(db: Db, auth: AppAuth, now = new Date()) {
  const rows = await db
    .select({ machine: machines, deviceId: deviceAssignments.deviceId })
    .from(machines)
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(and(eq(machines.organizationId, auth.organizationId), eq(machines.tier, "control")));
  const until = new Date(now.getTime() + APP_RULES.offlinePassHours * 3_600_000);
  const out = [];
  for (const { machine: m, deviceId } of rows) {
    if (effectiveMode(m, now.getTime()).mode === "locked") continue;
    const access = await operatorAccess(db, m, auth.operatorId, now);
    if (!access.approved || access.trainingMissing.length) continue;
    out.push({ machineCode: m.code, deviceId, bluetoothName: bluetoothName(deviceId), pass: unlockPass(deviceId, auth.operatorId, 0, now, until), validUntil: until.toISOString() });
  }
  return out;
}

/** An earlier start the device reported for an app pass (no check-in in the app yet): removed when the app's checklist arrives. */
export async function replaceAppStart(db: Db, auth: AppAuth, machineId: number, startedAt: Date) {
  await db
    .delete(checkins)
    .where(
      and(
        eq(checkins.machineId, machineId),
        eq(checkins.operatorId, auth.operatorId),
        inArray(checkins.method, ["app", "ble"]),
        sql`jsonb_array_length(${checkins.answers}) = 0`,
        gte(checkins.startedAt, startedAt),
        lt(checkins.startedAt, new Date(startedAt.getTime() + 3 * 3_600_000)),
      ),
    );
}
