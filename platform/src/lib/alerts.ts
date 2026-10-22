import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, checkins, checklistIssues, engineSessions, machines, operators, type Alert, type Machine } from "@/lib/db/schema";
import { isCheckinCurrent } from "@/lib/operators";
import { appTimeZone } from "@/lib/telemetry/engine";
import { clockTime, formatDistance, machineLabel } from "@/lib/format";

/**
 * Alerts for Safety & Access Monitoring (Tier 2, step 3). Plain functions that take the database,
 * so the rules can be tested without a server. Sending email is in src/lib/notify.ts.
 */

export const ALERT_RULES = {
  /** How long an armed machine's engine may run with nobody checked in before it's unauthorized use. */
  unauthorizedGraceMinutes: 5,
};

export const ALERT_LABELS = {
  "unauthorized-use": "Unauthorized use",
  "checklist-failed": "Repair needed",
  "not-approved": "Operator not approved",
  "not-at-machine": "Not confirmed at machine",
  /** Raised by the tamper watchdog (src/lib/tamper.ts); escalated = the same incident became high concern. */
  tamper: "Possible tamper",
  "tamper-escalated": "Possible tamper (escalated)",
  /** Raised by the fuel check (src/lib/fuel.ts): the tank level dropped while the engine was off. */
  "fuel-theft": "Possible fuel theft",
  /** The tank dropped while running, more than the engine burned (J1939 machines with a tank size). */
  "fuel-loss": "Possible fuel theft (while running)",
  /** A machine entered a worksite of type "restricted" (src/lib/safety.ts). */
  "restricted-area": "Restricted area entered",
} as const;

export type AlertType = keyof typeof ALERT_LABELS;

/** Alerts apply to Safety & Access Monitoring machines (and, later, Safety & Access Control). */
export function isMonitored(machine: Pick<Machine, "tier">): boolean {
  return machine.tier === "monitor" || machine.tier === "control";
}

/** Armed unless disarmed; a timed disarm re-arms itself when the time passes. */
export function isArmed(machine: Pick<Machine, "disarmed" | "disarmedUntil">, now = Date.now()): boolean {
  return !machine.disarmed || (machine.disarmedUntil !== null && machine.disarmedUntil.getTime() <= now);
}

/** Inserts an alert unless the same one was already raised. Returns the new alert, or nothing. */
async function raise(db: Db, values: typeof alerts.$inferInsert): Promise<Alert[]> {
  return db.insert(alerts).values(values).onConflictDoNothing().returning();
}

/**
 * Unauthorized use: an armed machine's engine has been running for the grace period and nobody has
 * checked in for this engine-on period (and nobody checked out within the grace period). Raised once
 * per engine-on period. Called after each device report (after syncCheckins), so it fires within a
 * report or two of the grace period ending.
 */
export async function checkUnauthorizedUse(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine || !isMonitored(machine) || !machine.engineOn || !isArmed(machine, now.getTime())) return [];

  const [session] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt)));
  const graceMs = ALERT_RULES.unauthorizedGraceMinutes * 60_000;
  if (!session || now.getTime() - session.startedAt.getTime() < graceMs) return [];

  // Anyone checked in? A check-in counts for this engine-on period if it's linked to it, or if it's
  // waiting for the engine to start (syncCheckins links it on the next report).
  const t = now.getTime();
  const open = await db
    .select()
    .from(checkins)
    .where(and(eq(checkins.machineId, machineId), isNull(checkins.endedAt)));
  const covered = open.some((c) =>
    c.engineSessionId ? c.engineSessionId === session.id && isCheckinCurrent(c, session, t) : isCheckinCurrent(c, null, t),
  );
  if (covered) return [];
  // Someone checked out moments ago: give the next operator the grace period to check in.
  const [latest] = await db
    .select({ endedAt: checkins.endedAt })
    .from(checkins)
    .where(eq(checkins.machineId, machineId))
    .orderBy(desc(checkins.endedAt))
    .limit(1);
  if (latest?.endedAt && t - latest.endedAt.getTime() < graceMs) return [];

  const minutes = Math.round((now.getTime() - session.startedAt.getTime()) / 60_000);
  return raise(db, {
    organizationId: machine.organizationId,
    machineId,
    type: "unauthorized-use",
    createdAt: now,
    engineSessionId: session.id,
    title: `Unauthorized use: ${machineLabel(machine)}`,
    detail: `Engine started at ${clockTime(session.startedAt, appTimeZone(), now.getTime())} and has been running for ${minutes} min with nobody checked in.`,
  });
}

/** Alerts for problems found at check-in: checklist items not OK, operator not approved, not at the machine. */
export async function raiseCheckinAlerts(db: Db, checkinId: number, now = new Date()): Promise<Alert[]> {
  const [row] = await db
    .select({ checkin: checkins, machine: machines, operatorName: operators.name })
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .where(eq(checkins.id, checkinId));
  if (!row || !isMonitored(row.machine)) return [];
  const { checkin: c, machine, operatorName: who } = row;
  const name = machineLabel(machine);
  const base = { organizationId: c.organizationId, machineId: machine.id, checkinId: c.id, createdAt: now };
  const raised: Alert[] = [];

  // Repair needed: only for issues this check-in opened or made more severe. A defect that's already
  // open stacks onto its issue without another alert (see recordIssues in checklists.ts).
  const issues = await db
    .select()
    .from(checklistIssues)
    .where(eq(checklistIssues.alertCheckinId, c.id));
  if (issues.length) {
    const others = (
      await db
        .select({ id: checklistIssues.id })
        .from(checklistIssues)
        .where(and(eq(checklistIssues.machineId, machine.id), isNull(checklistIssues.resolvedAt)))
    ).length - issues.length;
    const list = issues
      .map((i) => `${i.question} (${i.answerLabel}${i.reportCount > 1 ? `, now ${i.severity}` : ""})${i.note ? `: "${i.note}"` : ""}`)
      .join("; ");
    raised.push(
      ...(await raise(db, {
        ...base,
        type: "checklist-failed",
        title: `Repair needed: ${name}`,
        detail: [
          `${who} reported ${list}.`,
          c.lockoutRequested ? "The machine has been locked out for repair." : "",
          others > 0 ? `${others} other open issue${others === 1 ? "" : "s"} on this machine.` : "",
          c.notes ? `Notes: "${c.notes}"` : "",
        ]
          .filter(Boolean)
          .join(" "),
      })),
    );
  }
  if (!c.authorized) {
    raised.push(
      ...(await raise(db, {
        ...base,
        type: "not-approved",
        title: `Operator not approved: ${name}`,
        detail: `${who} checked in but isn't on the approved operator list for this machine.`,
      })),
    );
  }
  if (c.locationCheck === "far" || c.locationCheck === "no-phone-location") {
    raised.push(
      ...(await raise(db, {
        ...base,
        type: "not-at-machine",
        title: `Check-in not confirmed at machine: ${name}`,
        detail:
          c.locationCheck === "far"
            ? `${who} checked in ${formatDistance(c.distanceM)} away from the machine.`
            : `${who} didn't share their phone's location, so we couldn't confirm they were at the machine.`,
      })),
    );
  }
  return raised;
}

export async function acknowledgeAlert(db: Db, organizationId: number, alertId: number, note: string, now = new Date()) {
  await db
    .update(alerts)
    .set({ acknowledgedAt: now, ackNote: note.trim() || null })
    .where(and(eq(alerts.id, alertId), eq(alerts.organizationId, organizationId), isNull(alerts.acknowledgedAt)));
}
