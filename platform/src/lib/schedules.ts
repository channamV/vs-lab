import { and, eq, inArray, isNotNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, machines, operators, organizations, schedules, userDivisions, users, type Alert, type Machine, type Schedule } from "@/lib/db/schema";
import { hasRole, isPlatformAdminEmail, type AuthContext } from "@/lib/auth";
import { canSeeMachine } from "@/lib/divisions";
import { clockTime, machineLabel } from "@/lib/format";
import { currentMode, MODES, type Mode } from "@/lib/mode-types";
import { setMode } from "@/lib/modes";
import { appTimeZone } from "@/lib/telemetry/engine";
import { appUrl, sendEmail, senderSettings } from "@/lib/notify";
import {
  currentWindow,
  fmtInstant,
  resolveMachine,
  scheduledOperators,
  tzShort,
  validateSchedule,
  type ConflictRule,
  type ScheduleSpec,
} from "@/lib/schedule-time";

/**
 * Schedules (Jira V1-267; docs/schedules.md): future machine-mode changes and temporary operator access, run by
 * runSchedules every minute (Vercel Cron → /api/jobs/schedules). Each machine's mode is worked out from every
 * active schedule (resolveMachine): overrides beat regular schedules, the company's conflict rule decides between
 * equals (least restrictive by default), scheduled operator access turns a scheduled Locked into Access-Controlled.
 * When no window applies any more, the machine gets the ending schedule's end behaviour ("return to previous
 * mode" or a set mode). A manager changing the mode by hand wins until the next window. Changes go through
 * setMode (history attributed to the schedule; relay machines get the MODE command, unlocks first).
 *
 * Permissions: the same as doing it live (operating modes and operator approvals = managers and owners, within
 * their divisions), checked when a schedule is saved and again every time it runs.
 */
export const SCHEDULE_RULES = {
  /** A relay machine that hasn't confirmed a scheduled change after this long → "Scheduled change is late". */
  lateMinutes: 10,
  /** Overrides with a reminder: email the creator this long before they end. */
  reminderMinutes: 15,
  maxName: 80,
};

export class ScheduleError extends Error {}

export const CONFLICT_RULES: Record<ConflictRule, string> = {
  least_restrictive: "Least restrictive wins (Unlocked, then Access-Controlled, then Locked)",
  most_restrictive: "Most restrictive wins (Locked, then Access-Controlled, then Unlocked)",
};

/** The actions this user can schedule: the same as they can do live. */
export function allowedActions(auth: Pick<AuthContext, "role">): ("machine_mode" | "operator_access")[] {
  return hasRole(auth, "manager") ? ["machine_mode", "operator_access"] : [];
}

export const toSpec = (s: Schedule): ScheduleSpec => s;

export type ScheduleInput = Omit<ScheduleSpec, "id">;

type Actor = { userId: number | null; email: string; role: AuthContext["role"]; divisionIds: number[] | null; organizationId: number };

/** Throws unless the actor could make this change live, on every machine and operator in it. */
async function checkPermission(db: Db, actor: Actor, spec: ScheduleInput) {
  if (!allowedActions(actor).includes(spec.action as "machine_mode")) throw new ScheduleError("You can't schedule that action.");
  if (spec.machineIds.length) {
    const found = await db
      .select({ id: machines.id, organizationId: machines.organizationId, divisionId: machines.divisionId })
      .from(machines)
      .where(inArray(machines.id, spec.machineIds));
    if (found.length !== new Set(spec.machineIds).size || found.some((m) => !canSeeMachine(actor, m))) throw new ScheduleError("Machine not found.");
  } else if (actor.divisionIds !== null) {
    throw new ScheduleError("Choose the machines (you can only schedule machines in your divisions).");
  }
  if (spec.operatorIds.length) {
    const found = await db
      .select({ id: operators.id })
      .from(operators)
      .where(and(inArray(operators.id, spec.operatorIds), eq(operators.organizationId, actor.organizationId)));
    if (found.length !== new Set(spec.operatorIds).size) throw new ScheduleError("Operator not found.");
  }
}

function clean(input: ScheduleInput, now: Date): ScheduleInput {
  const s: ScheduleInput = {
    ...input,
    name: input.name.trim().slice(0, SCHEDULE_RULES.maxName),
    status: input.status === "paused" ? "paused" : "active",
    mode: input.action === "machine_mode" ? input.mode : null,
    machineIds: [...new Set(input.machineIds)],
    operatorIds: input.action === "operator_access" ? [...new Set(input.operatorIds)] : [],
    weekdays: input.recurrence === "weekly" ? [...new Set(input.weekdays)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [],
    noEnd: input.action === "machine_mode" && input.recurrence === "once" && input.noEnd,
    endBehavior: input.action === "machine_mode" && input.endBehavior === "set_mode" ? "set_mode" : "revert",
    endMode: input.action === "machine_mode" && input.endBehavior === "set_mode" ? input.endMode : null,
    remindBeforeExpiry: input.recurrence === "override" && input.remindBeforeExpiry,
  };
  if (s.recurrence === "weekly") Object.assign(s, { startDate: null, endDate: null, ...(s.allDay && { startTime: null, endTime: null }) });
  else Object.assign(s, { allDay: false, effectiveFrom: null, effectiveUntil: null, ...(s.noEnd && { endDate: null, endTime: null }) });
  const issues = validateSchedule(s, now.getTime());
  if (issues.length) throw new ScheduleError(issues[0]);
  return s;
}

const actorOf = (auth: AuthContext): Actor => ({ userId: auth.userId, email: auth.email, role: auth.role, divisionIds: auth.divisionIds, organizationId: auth.organizationId });

async function findSchedule(db: Db, organizationId: number, id: number) {
  const [s] = await db.select().from(schedules).where(and(eq(schedules.id, id), eq(schedules.organizationId, organizationId)));
  if (!s) throw new ScheduleError("Schedule not found.");
  return s;
}

export async function createSchedule(db: Db, auth: AuthContext, input: ScheduleInput, now = new Date()) {
  const spec = clean(input, now);
  await checkPermission(db, actorOf(auth), spec);
  const [row] = await db
    .insert(schedules)
    .values({ ...spec, organizationId: auth.organizationId, createdByUserId: auth.userId, createdBy: auth.email, createdAt: now, updatedAt: now })
    .returning();
  await reconcileOrganization(db, auth.organizationId, now);
  return row;
}

export async function updateSchedule(db: Db, auth: AuthContext, id: number, input: ScheduleInput, now = new Date()) {
  const existing = await findSchedule(db, auth.organizationId, id);
  await checkPermission(db, actorOf(auth), existing); // may change what's there
  const spec = clean(input, now);
  await checkPermission(db, actorOf(auth), spec);
  // The editor becomes responsible for it (its permissions are checked when it runs).
  await db
    .update(schedules)
    .set({ ...spec, createdByUserId: auth.userId, createdBy: auth.email, updatedAt: now, reminderSentFor: null })
    .where(eq(schedules.id, id));
  await reconcileOrganization(db, auth.organizationId, now, [existing]);
}

/** Pause or resume. Pausing stops future changes: machines it controls now keep their mode (nothing reverts). */
export async function setScheduleStatus(db: Db, auth: AuthContext, id: number, status: "active" | "paused", now = new Date()) {
  const existing = await findSchedule(db, auth.organizationId, id);
  await checkPermission(db, actorOf(auth), existing);
  await db.update(schedules).set({ status, updatedAt: now }).where(eq(schedules.id, id));
  if (status === "paused") {
    await db.update(machines).set({ scheduleId: null, modeBeforeSchedule: null }).where(eq(machines.scheduleId, id));
  }
  await reconcileOrganization(db, auth.organizationId, now);
}

/** Deletes it. If it's in effect, its end behaviour is applied now (unless another schedule applies). */
export async function deleteSchedule(db: Db, auth: AuthContext, id: number, now = new Date()) {
  const existing = await findSchedule(db, auth.organizationId, id);
  await checkPermission(db, actorOf(auth), existing);
  await db.delete(schedules).where(eq(schedules.id, id));
  await reconcileOrganization(db, auth.organizationId, now, [existing]);
}

export async function listSchedules(db: Db, organizationId: number) {
  return db.select().from(schedules).where(eq(schedules.organizationId, organizationId)).orderBy(schedules.name);
}

/** Can this user edit / pause / delete this schedule (all its machines are theirs, and they could do it live)? */
export function canManageSchedule(auth: AuthContext, s: Schedule, machineDivisions: Map<number, number | null>) {
  if (!allowedActions(auth).includes(s.action as "machine_mode")) return false;
  if (auth.divisionIds === null) return true;
  if (!s.machineIds.length) return false;
  return s.machineIds.every((id) => {
    const division = machineDivisions.get(id);
    return division !== undefined && division !== null && auth.divisionIds!.includes(division);
  });
}

// ---------- running ----------

/** The creator's permissions as they are now (null = they can't make these changes any more). */
async function creatorScope(db: Db, s: Schedule): Promise<Actor | null> {
  if (!s.createdByUserId) return null;
  const [u] = await db.select().from(users).where(eq(users.id, s.createdByUserId));
  if (!u || !u.active) return null;
  if (isPlatformAdminEmail(u.email)) return { userId: u.id, email: u.email, role: "owner", divisionIds: null, organizationId: s.organizationId };
  if (u.organizationId !== s.organizationId || !hasRole(u, "manager")) return null;
  if (u.role === "owner") return { userId: u.id, email: u.email, role: u.role, divisionIds: null, organizationId: s.organizationId };
  const limited = await db.select({ id: userDivisions.divisionId }).from(userDivisions).where(eq(userDivisions.userId, u.id));
  return { userId: u.id, email: u.email, role: u.role, divisionIds: limited.length ? limited.map((d) => d.id) : null, organizationId: s.organizationId };
}

/** GPS & Telematics has no Access-Controlled: it behaves as Unlocked there. */
const forTier = (mode: Mode, tier: Machine["tier"]): Mode => (tier === "gps" && mode === "access_controlled" ? "unlocked" : mode);

/**
 * Brings every machine of the organization in line with its schedules. `removed`: schedules just deleted or
 * changed, so their end behaviour can still be applied to machines they controlled.
 */
export async function reconcileOrganization(db: Db, organizationId: number, now = new Date(), removed: Schedule[] = []) {
  const [org] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!org) return [];
  const all = await db.select().from(schedules).where(eq(schedules.organizationId, organizationId));
  const fleet = await db.select().from(machines).where(eq(machines.organizationId, organizationId));
  // Each active schedule, limited to the machines its creator can still manage (permissions re-checked).
  const active: ScheduleSpec[] = [];
  for (const s of all.filter((x) => x.status === "active")) {
    const actor = await creatorScope(db, s);
    if (!actor || !allowedActions(actor).includes(s.action as "machine_mode")) continue;
    const allowed = fleet.filter((m) => canSeeMachine(actor, m)).map((m) => m.id);
    const machineIds = s.machineIds.length ? s.machineIds.filter((id) => allowed.includes(id)) : actor.divisionIds === null ? [] : allowed;
    if (s.machineIds.length && !machineIds.length) continue;
    if (!s.machineIds.length && actor.divisionIds !== null && !machineIds.length) continue;
    active.push({ ...s, machineIds });
  }
  const byId = new Map([...all, ...removed].map((s) => [s.id, s]));
  const rule = (org.scheduleConflictRule === "most_restrictive" ? "most_restrictive" : "least_restrictive") as ConflictRule;
  const allIds = fleet.map((m) => m.id);
  const t = now.getTime();
  const events: (number | null)[] = [];

  for (const m of fleet) {
    const desired = resolveMachine(m.id, active, allIds, rule, t, m.manualModeAt?.getTime() ?? null);
    const mode = currentMode(m, t);
    if (desired) {
      const target = forTier(desired.mode, m.tier);
      const schedule = byId.get(desired.scheduleId)!;
      // Taking control: remember the mode to go back to.
      const before = m.scheduleId === null ? mode : (m.modeBeforeSchedule ?? mode);
      if (mode !== target) {
        events.push(
          await setMode(db, organizationId, m.id, { mode: target, reason: `schedule “${schedule.name}”`, source: "schedule", scheduleId: schedule.id }, `Schedule “${schedule.name}”`, now),
        );
      }
      if (m.scheduleId !== desired.scheduleId || m.modeBeforeSchedule !== before) {
        await db.update(machines).set({ scheduleId: desired.scheduleId, modeBeforeSchedule: before }).where(eq(machines.id, m.id));
      }
    } else if (m.scheduleId !== null) {
      // The window that was controlling it has ended (or the schedule was deleted): apply its end behaviour.
      const ended = byId.get(m.scheduleId);
      const back = (ended?.endBehavior === "set_mode" && ended.endMode && ended.endMode in MODES ? ended.endMode : m.modeBeforeSchedule) as Mode | null;
      const target = back && back in MODES ? forTier(back, m.tier) : mode;
      if (target !== mode) {
        events.push(
          await setMode(
            db,
            organizationId,
            m.id,
            { mode: target, reason: `schedule “${ended?.name ?? "deleted"}” ended`, source: "schedule", scheduleId: ended?.id ?? null },
            `Schedule “${ended?.name ?? "deleted"}”`,
            now,
          ),
        );
      }
      await db.update(machines).set({ scheduleId: null, modeBeforeSchedule: null }).where(eq(machines.id, m.id));
    }
  }
  return events.filter((e): e is number => e !== null);
}

/** Every minute: apply schedules in every organization that has any (or machines still under one). */
export async function runSchedules(db: Db, now = new Date()) {
  const orgIds = new Set([
    ...(await db.selectDistinct({ id: schedules.organizationId }).from(schedules)).map((r) => r.id),
    ...(await db.selectDistinct({ id: machines.organizationId }).from(machines).where(isNotNull(machines.scheduleId))).map((r) => r.id),
  ]);
  const events: number[] = [];
  for (const id of orgIds) events.push(...(await reconcileOrganization(db, id, now)));
  const reminders = await sendOverrideReminders(db, now);
  const late = await checkLateChanges(db, now);
  return { organizations: orgIds.size, changes: events.length, events, reminders, late };
}

/** Operators who may start this machine now through a schedule (on top of its permanent approvals). */
export async function scheduledAccess(db: Db, organizationId: number, machineId: number, now = new Date()) {
  const rows = await db
    .select()
    .from(schedules)
    .where(and(eq(schedules.organizationId, organizationId), eq(schedules.status, "active"), eq(schedules.action, "operator_access")));
  return scheduledOperators(machineId, rows, now.getTime());
}

/** Overrides with a reminder: email the creator 15 minutes before they end (once per window). */
export async function sendOverrideReminders(db: Db, now = new Date()) {
  const due = await db
    .select({ s: schedules, email: users.email })
    .from(schedules)
    .leftJoin(users, eq(users.id, schedules.createdByUserId))
    .where(and(eq(schedules.status, "active"), eq(schedules.recurrence, "override"), eq(schedules.remindBeforeExpiry, true)));
  const sender = senderSettings();
  let sent = 0;
  for (const { s, email } of due) {
    const w = currentWindow(s, now.getTime());
    if (!w?.end || w.end - now.getTime() > SCHEDULE_RULES.reminderMinutes * 60_000) continue;
    if (s.reminderSentFor?.getTime() === w.end) continue;
    await db.update(schedules).set({ reminderSentFor: new Date(w.end) }).where(eq(schedules.id, s.id));
    sent++;
    if (!sender || !email) continue;
    const link = appUrl() ? `${appUrl()}/schedules/${s.id}` : "";
    await sendEmail(sender, [email], {
      subject: `Override ending soon: ${s.name}`,
      text: [
        `The temporary override “${s.name}” ends at ${fmtInstant(w.end, s.timezone)} ${tzShort(s.timezone, w.end)}.`,
        "To keep it going, edit the schedule and change its end time.",
        link,
        "",
        "— VS Lab",
      ].join("\n"),
    });
  }
  return sent;
}

/**
 * Relay machines (Safety & Access Control) that haven't confirmed a scheduled change within lateMinutes:
 * a "Scheduled change is late" alert for the fleet manager (once per change). The command keeps waiting for the
 * machine to reconnect. Machines without a relay don't need to confirm: the cloud applies their mode.
 */
export async function checkLateChanges(db: Db, now = new Date()): Promise<Alert[]> {
  const late = await db
    .select()
    .from(machines)
    .where(and(eq(machines.tier, "control"), eq(machines.modeSource, "schedule"), isNotNull(machines.modeChangedAt)));
  const raised: Alert[] = [];
  for (const m of late) {
    if (m.confirmedMode === m.mode || !m.modeChangedAt) continue;
    if (now.getTime() - m.modeChangedAt.getTime() < SCHEDULE_RULES.lateMinutes * 60_000) continue;
    if (m.scheduleLateAlertedAt && m.scheduleLateAlertedAt >= m.modeChangedAt) continue;
    await db.update(machines).set({ scheduleLateAlertedAt: now }).where(eq(machines.id, m.id));
    const [alert] = await db
      .insert(alerts)
      .values({
        organizationId: m.organizationId,
        machineId: m.id,
        type: "schedule-late",
        createdAt: now,
        title: `Scheduled change is late: ${machineLabel(m)}`,
        detail:
          `${machineLabel(m)} should have switched to ${MODES[m.mode as Mode]?.label ?? m.mode} at ${clockTime(m.modeChangedAt, appTimeZone(), now.getTime())}` +
          ` (${m.modeReason ?? "schedule"}), but hasn't confirmed it. It's probably out of coverage: the change will be applied when it reconnects.`,
      })
      .returning();
    raised.push(alert);
  }
  return raised;
}
