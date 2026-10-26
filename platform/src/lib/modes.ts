import { and, desc, eq, inArray, isNotNull, isNull, like, lte } from "drizzle-orm";
import { orgTimeZone } from "@/lib/org-time";
import type { Db } from "@/lib/db";
import { alerts, deviceAssignments, deviceCommands, engineSessions, machineModeChanges, machines, type Alert, type Machine } from "@/lib/db/schema";
import { clockTime, machineLabel } from "@/lib/format";
import { currentMode, isMode, MODES, modesFor, type Mode } from "@/lib/mode-types";
import { recordEvent } from "@/lib/notifications";
import { distanceMeters } from "@/lib/operators";
import { appTimeZone, startOfLocalDay } from "@/lib/telemetry/engine";

export { currentMode, MODES, modesFor, type Mode } from "@/lib/mode-types";

/**
 * Operating modes (docs/operating-modes.md): Access-Controlled, Unlocked, Locked, per machine, changed by
 * managers (now, or for a while), by schedules (later) and by timers running out. The checklist safety lock
 * (machines.locked_out_at) is separate and always counts as Locked.
 *  - GPS & Telematics: Unlocked or Locked ("alarmed": any start or movement alerts at once).
 *  - Safety & Access Monitoring: Access-Controlled = start without a check-in alerts after the grace period
 *    (alerts.ts); Unlocked = no such alert; Locked = any start or movement alerts at once, check-ins refused.
 *  - Safety & Access Control (relay, our firmware): the device enforces the mode. Each change is sent as a
 *    MODE command with the offline fallback; the device confirms (confirmed_mode).
 */
export const MODE_RULES = {
  /** Moved this far from where it was when locked → "Moved while Locked" (GPS wobble is a few metres). */
  movementMeters: 100,
  minSatellites: 4,
  /** Offline fallback: allowed hours without contact before the device switches. */
  offlineHours: [1, 168],
};

export class ModeError extends Error {}

export type ModeDuration = "indefinite" | "1h" | "4h" | "8h" | "morning" | "until";

/** When a timed change ends. "morning" = 6 AM tomorrow, company time. */
export function durationEnd(duration: ModeDuration, now: Date, until?: Date | null, timeZone = appTimeZone()): Date | null {
  const t = now.getTime();
  switch (duration) {
    case "indefinite":
      return null;
    case "1h":
      return new Date(t + 3_600_000);
    case "4h":
      return new Date(t + 4 * 3_600_000);
    case "8h":
      return new Date(t + 8 * 3_600_000);
    case "morning":
      return new Date(startOfLocalDay(t, timeZone, -1) + 6 * 3_600_000);
    case "until":
      if (!until || until.getTime() <= t) throw new ModeError("Choose a time in the future.");
      return until;
  }
}

/** The machine's mode right now, counting the checklist safety lock. */
export function effectiveMode(m: Pick<Machine, "mode" | "modeUntil" | "modeRevertTo" | "tier" | "lockedOutAt">, now = Date.now()) {
  if (m.lockedOutAt) return { mode: "locked" as Mode, safety: true };
  return { mode: currentMode(m, now), safety: false };
}

async function findMachine(db: Db, organizationId: number, machineId: number) {
  const [m] = await db.select().from(machines).where(and(eq(machines.id, machineId), eq(machines.organizationId, organizationId)));
  if (!m) throw new ModeError("Machine not found.");
  return m;
}

/**
 * Changes a machine's mode, now (until changed again) or for a while (then it returns to the mode it had).
 * Records the change, a "mode changed" notification event, and (relay machines) a MODE command for the device.
 * Returns the notification event id.
 */
export async function setMode(
  db: Db,
  organizationId: number,
  machineId: number,
  change: { mode: string; until?: Date | null; reason?: string; source?: "manager" | "schedule" | "timer"; scheduleId?: number | null },
  changedBy: string | null,
  now = new Date(),
): Promise<number | null> {
  const m = await findMachine(db, organizationId, machineId);
  if (!isMode(change.mode) || !modesFor(m.tier).includes(change.mode)) throw new ModeError("That mode isn't available for this machine's service level.");
  const until = change.until ?? null;
  if (until && until.getTime() <= now.getTime()) throw new ModeError("Choose a time in the future.");
  const before = currentMode(m, now.getTime());
  const reason = change.reason?.trim().slice(0, 300) || null;
  const source = change.source ?? "manager";
  // A timed change returns to the mode in force before it (not to an earlier timed change's mode).
  const revertTo = until ? (m.modeUntil && m.modeUntil.getTime() > now.getTime() && m.modeRevertTo ? m.modeRevertTo : before) : null;
  await db
    .update(machines)
    .set({
      mode: change.mode,
      modeUntil: until,
      modeRevertTo: revertTo,
      modeReason: reason,
      modeChangedAt: now,
      modeChangedBy: changedBy,
      modeSource: source,
      // A manager's change stands until the next schedule window (one running now is skipped).
      ...(source === "manager" && { manualModeAt: now, scheduleId: null, modeBeforeSchedule: null }),
      // A new lock starts from where the machine is now.
      ...(change.mode === "locked" && before !== "locked" && { lockAnchorLat: m.lastLat, lockAnchorLng: m.lastLng, lockMovementAlertedAt: null }),
    })
    .where(eq(machines.id, m.id));
  await db.insert(machineModeChanges).values({ organizationId, machineId, mode: change.mode, until, reason, source, changedBy, at: now, scheduleId: change.scheduleId ?? null });
  await sendModeToDevice(db, { ...m, mode: change.mode }, changedBy ?? source, now);
  return recordEvent(db, {
    organizationId,
    machineId,
    type: "mode_changed",
    detail: describeChange(before, change.mode, until, reason, changedBy, now, await orgTimeZone(db, organizationId)),
    occurredAt: now,
  });
}

function describeChange(before: Mode, after: Mode, until: Date | null, reason: string | null, by: string | null, now: Date, timeZone: string) {
  const when = until ? ` until ${clockTime(until, timeZone, now.getTime())}` : "";
  return `${MODES[before].label} → ${MODES[after].label}${when}${reason ? ` (${reason})` : ""}${by ? ` by ${by}` : ""}.`;
}

/** Timed changes that have run out return to their earlier mode (from the watchdog, every 5 minutes). */
export async function applyModeTimers(db: Db, now = new Date()): Promise<number[]> {
  const due = await db
    .select()
    .from(machines)
    .where(and(isNotNull(machines.modeUntil), lte(machines.modeUntil, now)));
  const events: number[] = [];
  for (const m of due) {
    const back = isMode(m.modeRevertTo) && modesFor(m.tier).includes(m.modeRevertTo) ? m.modeRevertTo : modesFor(m.tier)[0];
    const id = await setMode(db, m.organizationId, m.id, { mode: back, reason: `the ${MODES[currentModeOf(m)].label} period ended`, source: "timer" }, null, now);
    if (id) events.push(id);
  }
  return events;
}
const currentModeOf = (m: Machine): Mode => (isMode(m.mode) ? m.mode : "unlocked");

/** What a relay machine does after a long time without contact. null = keep its mode. */
export async function setOfflineFallback(db: Db, organizationId: number, machineId: number, offlineMode: string | null, hours: number, changedBy: string, now = new Date()) {
  const m = await findMachine(db, organizationId, machineId);
  if (offlineMode !== null && (!isMode(offlineMode) || !modesFor(m.tier).includes(offlineMode))) throw new ModeError("Choose a mode for when the machine is offline.");
  const [min, max] = MODE_RULES.offlineHours;
  if (!Number.isInteger(hours) || hours < min || hours > max) throw new ModeError(`Hours offline must be between ${min} and ${max}.`);
  await db.update(machines).set({ offlineMode, offlineAfterHours: hours }).where(eq(machines.id, m.id));
  await sendModeToDevice(db, { ...m, offlineMode, offlineAfterHours: hours }, changedBy, now);
}

/**
 * Relay machines only: queue MODE=<mode>\t<offline mode or keep>\t<hours> for the paired device (replacing an
 * unsent one). The device confirms through the command answer (confirmMode).
 */
async function sendModeToDevice(db: Db, m: Machine, createdBy: string, now: Date) {
  if (m.tier !== "control") return;
  const [pairing] = await db
    .select({ deviceId: deviceAssignments.deviceId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.machineId, m.id), isNull(deviceAssignments.endedAt)));
  if (!pairing) return;
  // A newer mode replaces one the device hasn't answered yet.
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.deviceId, pairing.deviceId), inArray(deviceCommands.status, ["pending", "sent"]), like(deviceCommands.command, "MODE=%")));
  // A repair lockout (checklist) counts as Locked: the device keeps the starter blocked until it's cleared.
  const mode: Mode = m.lockedOutAt ? "locked" : currentModeOf(m);
  await db.insert(deviceCommands).values({
    deviceId: pairing.deviceId,
    command: `MODE=${mode}\t${m.offlineMode ?? "keep"}\t${m.offlineAfterHours}`,
    label: `Set mode: ${MODES[mode].label}${m.lockedOutAt ? " (locked out for repair)" : ""}${m.offlineMode ? ` (offline after ${m.offlineAfterHours} h: ${MODES[m.offlineMode as Mode]?.label ?? m.offlineMode})` : ""}`,
    createdBy,
    createdAt: now,
    expiresAt: new Date(now.getTime() + 7 * 86_400_000),
  });
}

/** Sends a relay machine's mode again (after a repair lockout starts or is cleared). */
export async function syncRelayMode(db: Db, machineId: number, changedBy: string, now = new Date()) {
  const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (m) await sendModeToDevice(db, m, changedBy, now);
}

/** The device answered a MODE command: it's now enforcing that mode. */
export async function confirmMode(db: Db, deviceId: string, command: string, ok: boolean, now = new Date()) {
  if (!ok || !command.startsWith("MODE=")) return;
  const mode = command.slice(5).split("\t")[0];
  if (!isMode(mode)) return;
  const [pairing] = await db
    .select({ machineId: deviceAssignments.machineId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endedAt)));
  if (pairing) await db.update(machines).set({ confirmedMode: mode, confirmedModeAt: now }).where(eq(machines.id, pairing.machineId));
}

// ---------- Locked machines being used or moved (after each device report) ----------

/**
 * Locked (by a manager, or the safety lock): an engine start raises "Started while Locked" (once per engine
 * session) and moving more than MODE_RULES.movementMeters from where it was locked raises "Moved while Locked"
 * (once per lock). Every tier: on GPS & Telematics this is the "alarmed" mode.
 */
export async function checkLockedUse(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!m || effectiveMode(m, now.getTime()).mode !== "locked") return [];
  const tz = await orgTimeZone(db, m.organizationId);
  const raised: Alert[] = [];
  const why = m.lockedOutAt ? `locked for repair${m.lockedOutReason ? `: ${m.lockedOutReason}` : ""}` : `Locked${m.modeReason ? ` (${m.modeReason})` : ""}`;

  if (m.engineOn) {
    const [session] = await db
      .select()
      .from(engineSessions)
      .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt)))
      .orderBy(desc(engineSessions.startedAt))
      .limit(1);
    if (session) {
      raised.push(
        ...(await db
          .insert(alerts)
          .values({
            organizationId: m.organizationId,
            machineId,
            type: "locked-use",
            engineSessionId: session.id,
            createdAt: now,
            title: `Started while Locked: ${machineLabel(m)}`,
            detail: `The engine started at ${clockTime(session.startedAt, tz, now.getTime())} while the machine is ${why}.`,
          })
          .onConflictDoNothing()
          .returning()),
      );
    }
  }

  if (m.lastLat !== null && m.lastLng !== null) {
    if (m.lockAnchorLat === null || m.lockAnchorLng === null) {
      await db.update(machines).set({ lockAnchorLat: m.lastLat, lockAnchorLng: m.lastLng }).where(eq(machines.id, machineId));
    } else if (!m.lockMovementAlertedAt) {
      const moved = distanceMeters({ lat: m.lastLat, lng: m.lastLng }, { lat: m.lockAnchorLat, lng: m.lockAnchorLng });
      if (moved >= MODE_RULES.movementMeters) {
        const claimed = await db
          .update(machines)
          .set({ lockMovementAlertedAt: now })
          .where(and(eq(machines.id, machineId), isNull(machines.lockMovementAlertedAt)))
          .returning({ id: machines.id });
        if (claimed.length) {
          const dist = moved >= 1000 ? `${(moved / 1000).toFixed(1)} km` : `${Math.round(moved)} m`;
          raised.push(
            ...(await db
              .insert(alerts)
              .values({
                organizationId: m.organizationId,
                machineId,
                type: "locked-movement",
                createdAt: now,
                title: `Moved while Locked: ${machineLabel(m)}`,
                detail: `The machine is ${dist} from where it was when it was locked, ${m.engineOn ? "with the engine running" : "with the engine off (towed or carried?)"}. It's ${why}.`,
              })
              .returning()),
          );
        }
      }
    }
  }
  return raised;
}

/** Recent mode changes for the machine page. */
export async function modeHistory(db: Db, machineId: number, limit = 10) {
  return db.select().from(machineModeChanges).where(eq(machineModeChanges.machineId, machineId)).orderBy(desc(machineModeChanges.at)).limit(limit);
}
