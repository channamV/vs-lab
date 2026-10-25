import { and, eq, inArray, isNull, like } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, deviceAssignments, deviceCommands, engineSessions, machines } from "@/lib/db/schema";
import { effectiveMode } from "@/lib/modes";
import { isCheckinCurrent } from "@/lib/operators";
import { effectiveEnd } from "@/lib/telemetry/engine";

/**
 * Beeps for the operator at the machine (Craig, 2026-10-25; docs/operator-alerts.md). The device's buzzer is the
 * only way to reach an operator who checked in with a Bluetooth beacon, or who started without checking in.
 * VS-lab decides what applies and sends the device `ALERT=<kind>` when it changes; our firmware plays the pattern
 * every OPERATOR_ALERT_RULES.repeatSeconds while the engine runs, until `ALERT=none` (or it sleeps).
 * Only while Access-Controlled (Safety & Access Monitoring / Control): Unlocked means anyone may operate it.
 */

export const OPERATOR_ALERTS = {
  none: { pattern: "", meaning: "" },
  not_checked_in: { pattern: "Two long beeps", meaning: "Nobody is checked in. Scan the QR code and check in." },
  checklist_due: { pattern: "Three short beeps", meaning: "The pre-start checklist is due. Scan the QR code and complete it." },
} as const;

export type OperatorAlert = keyof typeof OPERATOR_ALERTS;

export const OPERATOR_ALERT_RULES = {
  /** The device repeats the pattern this often while it applies (firmware setting, documented here). */
  repeatSeconds: 30,
  /** An ALERT command the device hasn't answered in this long is stale: a newer state replaces it anyway. */
  expiresMinutes: 10,
};

/** What the operator should hear (pure). */
export function desiredAlert(input: {
  tier: string;
  mode: string;
  engineRunning: boolean;
  /** The current check-in: how many checklist answers it has, and whether an earlier checklist covers it. */
  checkin: { answers: number; coveredBy: number | null } | null;
}): OperatorAlert {
  if (input.tier === "gps" || input.mode !== "access_controlled" || !input.engineRunning) return "none";
  if (!input.checkin) return "not_checked_in";
  if (input.checkin.answers === 0 && input.checkin.coveredBy === null) return "checklist_due";
  return "none";
}

/**
 * Works out the machine's alert and, when it changed, sends it to the paired device (replacing an unanswered older
 * one). After each device report and check-in. Returns the alert.
 */
export async function syncOperatorAlert(db: Db, machineId: number, now = new Date()): Promise<OperatorAlert> {
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) return "none";
  const t = now.getTime();
  const [session] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt)));
  const engineRunning = Boolean(session && session.startedAt.getTime() <= t && effectiveEnd(session, t) >= t);
  const [open] = await db
    .select({ checkin: checkins, linked: engineSessions })
    .from(checkins)
    .leftJoin(engineSessions, eq(engineSessions.id, checkins.engineSessionId))
    .where(and(eq(checkins.machineId, machineId), isNull(checkins.endedAt)));
  const current = open && isCheckinCurrent(open.checkin, open.linked, t) ? open.checkin : null;
  const alert = desiredAlert({
    tier: machine.tier,
    mode: effectiveMode(machine, t).mode,
    engineRunning,
    checkin: current ? { answers: current.answers.length, coveredBy: current.checklistFromCheckinId } : null,
  });
  if (alert === machine.operatorAlert) return alert;
  await db.update(machines).set({ operatorAlert: alert }).where(eq(machines.id, machineId));
  const [pairing] = await db
    .select({ deviceId: deviceAssignments.deviceId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.machineId, machineId), isNull(deviceAssignments.endedAt)));
  if (!pairing) return alert;
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.deviceId, pairing.deviceId), inArray(deviceCommands.status, ["pending", "sent"]), like(deviceCommands.command, "ALERT=%")));
  await db.insert(deviceCommands).values({
    deviceId: pairing.deviceId,
    command: `ALERT=${alert}`,
    label: alert === "none" ? "Operator alert: stop" : `Operator alert: ${OPERATOR_ALERTS[alert].pattern.toLowerCase()}`,
    createdBy: "VS-lab",
    createdAt: now,
    expiresAt: new Date(t + OPERATOR_ALERT_RULES.expiresMinutes * 60_000),
  });
  return alert;
}
