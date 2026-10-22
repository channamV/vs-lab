import { and, desc, eq, gte, inArray, isNull } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  alerts,
  checkins,
  divisions,
  machines,
  notificationDeliveries,
  notificationEvents,
  notificationRules,
  operators,
  userDivisions,
  users,
  worksites,
  type Alert,
  type NotificationEvent,
  type NotificationRule,
  type Role,
} from "@/lib/db/schema";
import type { AlertType } from "@/lib/alerts";
import { canSeeMachine, type Scope } from "@/lib/divisions";
import { machineLabel } from "@/lib/format";
import { appUrl, senderSettings, sendEmail, type EmailMessage } from "@/lib/notify";
import { appTimeZone } from "@/lib/telemetry/engine";

/**
 * Notifications: events (engine starts and stops, alerts, machine and approval changes) are recorded,
 * matched against each user's rules ("subscriptions"), and emailed in the background. Modelled on
 * Veristart's production notification subscriptions. Plain functions that take the database, so they
 * can be tested without a server.
 */

export class NotificationError extends Error {}

/** Event types people can subscribe to. Wording follows the production portal where the event matches. */
export const EVENT_TYPES = {
  start: { label: "Machine Start", description: "The engine started." },
  stop: { label: "Machine Stop", description: "The engine stopped." },
  start_no_checklist: {
    label: "Start Without Checklist",
    description: "An armed Safety & Access Monitoring machine ran for 5 minutes with nobody checked in (unauthorized use).",
  },
  checklist_repair: {
    label: "Checklist — Repair Needed",
    description: "A new minor or major defect on a pre-start checklist (a repeat of an issue that's already open doesn't count again).",
  },
  operator_not_approved: {
    label: "Operator Not Approved",
    description: "Someone checked in who isn't on the machine's approved operator list.",
  },
  not_at_machine: {
    label: "Check-in Not at Machine",
    description: "A check-in from a phone that was far from the machine, or didn't share its location.",
  },
  equipment_created: { label: "Equipment Created", description: "A machine was added." },
  equipment_updated: { label: "Equipment Updated", description: "A machine's details were changed." },
  operator_assigned: { label: "Operator Assigned", description: "An operator was added to a machine's approved list." },
  operator_revoked: { label: "Operator Revoked", description: "An operator was removed from a machine's approved list." },
  equipment_locked: { label: "Equipment Locked", description: "An operator locked a machine out for repair after reporting a major defect." },
  equipment_offline: {
    label: "Equipment Connectivity Status",
    description: "A tracking device went quiet for longer than expected (with how concerning that is), or came back online.",
  },
  engine_fault: {
    label: "Engine Fault Code",
    description: "The machine's engine computer reported a new fault code (J1939; needs a device that reads engine data).",
  },
  low_battery: {
    label: "Low Battery Warning",
    description: "The machine's battery is low with the engine off (below 11.9 V, or 23.8 V on 24 V machines): it may not start.",
  },
  worksite_enter: { label: "Entered Worksite", description: "A machine moved into one of the chosen worksites." },
  worksite_leave: { label: "Left Worksite", description: "A machine moved out of one of the chosen worksites." },
  worksite_dwell: {
    label: "Stayed Too Long at Worksite",
    description: "A machine has been at a worksite longer than the time limit set for that site.",
  },
  possible_fuel_theft: {
    label: "Possible Fuel Theft",
    description:
      "The fuel level dropped between the engine stopping and starting again, or (J1939 machines with a tank size) dropped while running by more than the engine burned.",
  },
  refuel: {
    label: "Refuelled",
    description: "The fuel level went up: a refuel, while parked or running (machines that report fuel level). Also in the fuel log.",
  },
  restricted_area: {
    label: "Restricted Area Entered",
    description: "A machine entered a worksite marked as a restricted area (exclusion zone). Also raises an alert.",
  },
  speeding: {
    label: "Speeding",
    description: "A machine went over the fleet speed limit, or a worksite's own limit, for more than 10 seconds (GPS speed).",
  },
  excessive_idle: {
    label: "Excessive Idling",
    description: "A machine has idled (engine running at low RPM, not moving) longer than the company's limit. Needs a device that reads engine RPM.",
  },
  operator_fatigue: {
    label: "Operator Fatigue",
    description: "An operator went over the daily hours limit, or worked too long without a 15-minute break (from check-ins and engine time).",
  },
  start_while_locked: {
    label: "Start While Locked",
    description: "The engine started on a machine that's Locked (by a manager, or locked out for repair). Also an alert.",
  },
  unauthorized_movement: {
    label: "Unauthorized Machine Movement",
    description: "A Locked machine moved more than 100 m from where it was locked, with or without its engine running. Also an alert.",
  },
  mode_changed: {
    label: "Operating Mode Changed",
    description: "A machine's mode changed (Access-Controlled, Unlocked or Locked): by a manager, a schedule, or a timed change ending.",
  },
  possible_tamper: {
    label: "Possible Tamper",
    description:
      "Medium or high concern: a device stopped reporting unexpectedly, restarted without signing off, came back somewhere else, or reported a different vehicle.",
  },
} as const;

export type EventType = keyof typeof EVENT_TYPES;

/** Production event types we can't detect yet (they need firmware or hardware we don't have). */
export const LATER_EVENT_TYPES = [
  "Equipment Removed",
  "Equipment Unlock / Operator Bypass",
  "Equipment Access Control",
];

/** Which event each alert raises. */
export const ALERT_EVENT: Record<AlertType, EventType> = {
  "unauthorized-use": "start_no_checklist",
  "checklist-failed": "checklist_repair",
  "not-approved": "operator_not_approved",
  "not-at-machine": "not_at_machine",
  tamper: "possible_tamper",
  "tamper-escalated": "possible_tamper",
  "fuel-theft": "possible_fuel_theft",
  "fuel-loss": "possible_fuel_theft",
  "restricted-area": "restricted_area",
  "locked-use": "start_while_locked",
  "locked-movement": "unauthorized_movement",
};

export const ALERT_EVENT_TYPES = [...new Set(Object.values(ALERT_EVENT))];

export const CHANNELS = { email: "Email" } as const;

export const isEventType = (value: string): value is EventType => value in EVENT_TYPES;

/** Event types a rule's worksite filter applies to. */
export const WORKSITE_EVENT_TYPES: string[] = ["worksite_enter", "worksite_leave", "worksite_dwell"] satisfies EventType[];

// ---------- Rules ----------

export type RuleInput = {
  name: string;
  eventTypes: string[];
  machineIds: number[];
  divisionIds: number[];
  operatorIds: number[];
  /** Only used by worksite events; empty = any worksite. */
  worksiteIds?: number[];
  weekdays: number[];
  startTime: string;
  endTime: string;
};

/** What a user can see (the same rules as signing in): owners everything, others limited by divisions. */
export async function scopeOfUser(db: Db, user: { id: number; organizationId: number; role: Role }): Promise<Scope> {
  if (user.role === "owner") return { organizationId: user.organizationId, divisionIds: null };
  const rows = await db.select({ id: userDivisions.divisionId }).from(userDivisions).where(eq(userDivisions.userId, user.id));
  return { organizationId: user.organizationId, divisionIds: rows.length ? rows.map((r) => r.id) : null };
}

async function userInOrg(db: Db, organizationId: number, userId: number) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)));
  if (!user) throw new NotificationError("User not found.");
  return user;
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

async function cleanRule(db: Db, organizationId: number, userId: number, input: RuleInput) {
  const user = await userInOrg(db, organizationId, userId);
  const scope = await scopeOfUser(db, user);
  const name = input.name.trim();
  if (!name) throw new NotificationError("Enter a subscription name.");
  const eventTypes = [...new Set(input.eventTypes)];
  if (eventTypes.length === 0) throw new NotificationError("Choose at least one event type.");
  if (!eventTypes.every(isEventType)) throw new NotificationError("Unknown event type.");

  const machineIds = [...new Set(input.machineIds)];
  if (machineIds.length) {
    const found = await db.select().from(machines).where(inArray(machines.id, machineIds));
    if (found.length !== machineIds.length || !found.every((m) => canSeeMachine(scope, m))) {
      throw new NotificationError("Machine not found.");
    }
  }
  const divisionIds = [...new Set(input.divisionIds)];
  if (divisionIds.length) {
    const found = await db
      .select({ id: divisions.id })
      .from(divisions)
      .where(and(eq(divisions.organizationId, organizationId), inArray(divisions.id, divisionIds)));
    const allowed = found.filter((d) => !scope.divisionIds || scope.divisionIds.includes(d.id));
    if (allowed.length !== divisionIds.length) throw new NotificationError("Division not found.");
  }
  const operatorIds = [...new Set(input.operatorIds)];
  if (operatorIds.length) {
    const found = await db
      .select({ id: operators.id })
      .from(operators)
      .where(and(eq(operators.organizationId, organizationId), inArray(operators.id, operatorIds)));
    if (found.length !== operatorIds.length) throw new NotificationError("Operator not found.");
  }
  // The worksite filter only means something with a worksite event; otherwise it's cleared.
  const worksiteIds = eventTypes.some((t) => WORKSITE_EVENT_TYPES.includes(t)) ? [...new Set(input.worksiteIds ?? [])] : [];
  if (worksiteIds.length) {
    const found = await db
      .select({ id: worksites.id })
      .from(worksites)
      .where(and(eq(worksites.organizationId, organizationId), inArray(worksites.id, worksiteIds)));
    if (found.length !== worksiteIds.length) throw new NotificationError("Worksite not found.");
  }
  const weekdays = [...new Set(input.weekdays)].sort();
  if (!weekdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) throw new NotificationError("Unknown weekday.");
  const startTime = input.startTime.trim();
  const endTime = input.endTime.trim();
  if ((startTime || endTime) && !(TIME.test(startTime) && TIME.test(endTime))) {
    throw new NotificationError("Set both From and To times (or neither).");
  }
  if (startTime && startTime === endTime) throw new NotificationError("From and To can't be the same time.");
  return { name, eventTypes, machineIds, divisionIds, operatorIds, worksiteIds, weekdays, startTime, endTime, timezone: appTimeZone() };
}

export async function createRule(db: Db, organizationId: number, userId: number, input: RuleInput) {
  const values = await cleanRule(db, organizationId, userId, input);
  const [rule] = await db.insert(notificationRules).values({ organizationId, userId, ...values }).returning();
  return rule;
}

/** Saves changes. Leaves the rule on or off as it was (pausing is separate). */
export async function updateRule(db: Db, organizationId: number, userId: number, ruleId: number, input: RuleInput) {
  const values = await cleanRule(db, organizationId, userId, input);
  const updated = await db
    .update(notificationRules)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(notificationRules.id, ruleId), eq(notificationRules.userId, userId), eq(notificationRules.organizationId, organizationId)))
    .returning({ id: notificationRules.id });
  if (updated.length === 0) throw new NotificationError("Subscription not found.");
}

export async function setRuleEnabled(db: Db, organizationId: number, userId: number, ruleId: number, enabled: boolean) {
  await db
    .update(notificationRules)
    .set({ enabled, updatedAt: new Date() })
    .where(and(eq(notificationRules.id, ruleId), eq(notificationRules.userId, userId), eq(notificationRules.organizationId, organizationId)));
}

export async function deleteRule(db: Db, organizationId: number, userId: number, ruleId: number) {
  await db
    .delete(notificationRules)
    .where(and(eq(notificationRules.id, ruleId), eq(notificationRules.userId, userId), eq(notificationRules.organizationId, organizationId)));
}

export async function getRule(db: Db, organizationId: number, userId: number, ruleId: number) {
  const [rule] = await db
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.id, ruleId), eq(notificationRules.userId, userId), eq(notificationRules.organizationId, organizationId)));
  return rule ?? null;
}

export async function listRules(db: Db, organizationId: number, userId: number) {
  await userInOrg(db, organizationId, userId);
  return db
    .select()
    .from(notificationRules)
    .where(and(eq(notificationRules.userId, userId), eq(notificationRules.organizationId, organizationId)))
    .orderBy(notificationRules.id);
}

/** New owners and managers get every alert by email, as before subscriptions existed. Viewers start with none. */
export async function addDefaultRule(db: Db, user: { id: number; organizationId: number; role: Role }) {
  if (user.role === "viewer") return;
  await db.insert(notificationRules).values({
    organizationId: user.organizationId,
    userId: user.id,
    name: "All alerts",
    eventTypes: ALERT_EVENT_TYPES,
    timezone: appTimeZone(),
  });
}

// ---------- Matching (pure) ----------

const WEEKDAY = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 } as Record<string, number>;

/** Day of week (0 = Sunday) and "HH:mm" at `at` in the given time zone. */
export function localDayAndTime(at: Date, timeZone: string): { weekday: number; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { weekday: WEEKDAY[parts.weekday], time: `${parts.hour}:${parts.minute}` };
}

/**
 * Whether `at` is inside the rule's schedule. Empty days = every day; no times = all day. From is
 * included, To is not, and a window that ends before it starts runs overnight (18:00–06:00). For an
 * overnight window, the morning part counts for the day it started (Fri 18:00–Sat 06:00 is "Friday").
 */
export function inSchedule(rule: Pick<NotificationRule, "weekdays" | "startTime" | "endTime" | "timezone">, at: Date): boolean {
  const { weekday, time } = localDayAndTime(at, rule.timezone);
  if (!rule.startTime || !rule.endTime) return rule.weekdays.length === 0 || rule.weekdays.includes(weekday);
  const overnight = rule.startTime > rule.endTime;
  if (!overnight) {
    return time >= rule.startTime && time < rule.endTime && (rule.weekdays.length === 0 || rule.weekdays.includes(weekday));
  }
  if (time >= rule.startTime) return rule.weekdays.length === 0 || rule.weekdays.includes(weekday);
  if (time < rule.endTime) return rule.weekdays.length === 0 || rule.weekdays.includes((weekday + 6) % 7);
  return false;
}

/** Whether a rule wants this event (type, machine/division, operator, worksite, schedule). Visibility is checked separately. */
export function ruleMatches(
  rule: Pick<
    NotificationRule,
    "enabled" | "eventTypes" | "machineIds" | "divisionIds" | "operatorIds" | "worksiteIds" | "weekdays" | "startTime" | "endTime" | "timezone"
  >,
  event: { type: string; operatorId: number | null; worksiteId?: number | null; occurredAt: Date },
  machine: { id: number; divisionId: number | null },
): boolean {
  if (!rule.enabled || !rule.eventTypes.includes(event.type)) return false;
  if (rule.machineIds.length || rule.divisionIds.length) {
    const inDivision = machine.divisionId !== null && rule.divisionIds.includes(machine.divisionId);
    if (!rule.machineIds.includes(machine.id) && !inDivision) return false;
  }
  if (rule.operatorIds.length && (event.operatorId === null || !rule.operatorIds.includes(event.operatorId))) return false;
  if (rule.worksiteIds.length && WORKSITE_EVENT_TYPES.includes(event.type)) {
    if (event.worksiteId == null || !rule.worksiteIds.includes(event.worksiteId)) return false;
  }
  return inSchedule(rule, event.occurredAt);
}

// ---------- Recording and delivering ----------

export type NewEvent = {
  organizationId: number;
  machineId: number;
  type: EventType;
  operatorId?: number | null;
  engineSessionId?: number | null;
  alertId?: number | null;
  worksiteId?: number | null;
  worksiteVisitId?: number | null;
  detail?: string | null;
  occurredAt?: Date;
};

/** Records an event to be delivered (by processEvents). Returns its id, or null if it was already recorded. */
export async function recordEvent(db: Db, event: NewEvent): Promise<number | null> {
  const [row] = await db
    .insert(notificationEvents)
    .values({ ...event, occurredAt: event.occurredAt ?? new Date() })
    .onConflictDoNothing()
    .returning({ id: notificationEvents.id });
  return row?.id ?? null;
}

/** Records an event for each new alert (with the check-in's operator) and delivers them. */
export async function deliverAlerts(db: Db, newAlerts: Alert[]) {
  const ids: number[] = [];
  for (const alert of newAlerts) {
    const [checkin] = alert.checkinId
      ? await db.select({ operatorId: checkins.operatorId }).from(checkins).where(eq(checkins.id, alert.checkinId))
      : [];
    const id = await recordEvent(db, {
      organizationId: alert.organizationId,
      machineId: alert.machineId,
      type: ALERT_EVENT[alert.type as AlertType],
      alertId: alert.id,
      operatorId: checkin?.operatorId ?? null,
      engineSessionId: alert.engineSessionId,
      occurredAt: alert.createdAt,
    });
    if (id) ids.push(id);
  }
  await processEvents(db, { eventIds: ids });
}

const splitEmails = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Matches pending events against rules and emails each matching person once per event. Pass the
 * events to process, or a machine to process all of its pending events. Engine events get their
 * operator from the check-in linked to that engine-on period (check-ins are synced first).
 * Alerts also go to ALERT_EMAIL_TO (Veristart staff).
 */
export async function processEvents(db: Db, which: { eventIds?: number[]; machineId?: number }, now = new Date()) {
  if (which.eventIds && which.eventIds.length === 0) return;
  const pending = await db
    .select()
    .from(notificationEvents)
    .where(
      and(
        isNull(notificationEvents.processedAt),
        which.eventIds ? inArray(notificationEvents.id, which.eventIds) : undefined,
        which.machineId ? eq(notificationEvents.machineId, which.machineId) : undefined,
      ),
    )
    .orderBy(notificationEvents.occurredAt);
  for (const event of pending) {
    try {
      await deliver(db, event, now);
    } catch (err) {
      console.error("Notification failed", event.id, err);
    }
  }
}

async function deliver(db: Db, event: NotificationEvent, now: Date) {
  const [machine] = await db.select().from(machines).where(eq(machines.id, event.machineId));
  if (!machine) return;

  if (!event.operatorId && event.engineSessionId) {
    const [linked] = await db
      .select({ operatorId: checkins.operatorId })
      .from(checkins)
      .where(eq(checkins.engineSessionId, event.engineSessionId))
      .orderBy(desc(checkins.startedAt))
      .limit(1);
    if (linked) {
      event.operatorId = linked.operatorId;
      await db.update(notificationEvents).set({ operatorId: linked.operatorId }).where(eq(notificationEvents.id, event.id));
    }
  }

  // Matching rules of active users who can see the machine, grouped by person.
  const rows = await db
    .select({ rule: notificationRules, user: users })
    .from(notificationRules)
    .innerJoin(users, eq(users.id, notificationRules.userId))
    .where(and(eq(notificationRules.organizationId, event.organizationId), eq(notificationRules.enabled, true), eq(users.active, true)));
  const matching = rows.filter((r) => r.user.organizationId === event.organizationId && ruleMatches(r.rule, event, machine));
  const byUser = new Map<number, { user: (typeof rows)[number]["user"]; ruleNames: string[] }>();
  for (const { rule, user } of matching) {
    const entry = byUser.get(user.id) ?? { user, ruleNames: [] };
    entry.ruleNames.push(rule.name);
    byUser.set(user.id, entry);
  }
  const recipients = [];
  for (const entry of byUser.values()) {
    if (canSeeMachine(await scopeOfUser(db, entry.user), machine)) recipients.push(entry);
  }

  const message = await eventEmail(db, event, machine);
  const sender = senderSettings();
  const results: string[] = [];
  let firstError: string | null = null;
  const send = async (userId: number | null, address: string, ruleNames: string[]) => {
    const result = sender
      ? await sendEmail(sender, [address], withRules(message, ruleNames))
      : ({ ok: false, error: null } as const);
    const status = !sender ? "not-configured" : result.ok ? "sent" : "failed";
    results.push(status);
    if (!result.ok && result.error) firstError ??= result.error;
    await db
      .insert(notificationDeliveries)
      .values({
        eventId: event.id,
        userId,
        ruleNames,
        channel: "email",
        recipient: address,
        status,
        error: result.ok ? null : result.error,
        at: now,
      })
      .onConflictDoNothing();
  };
  for (const { user, ruleNames } of recipients) await send(user.id, user.email, ruleNames);
  if (event.alertId) {
    for (const address of splitEmails(process.env.ALERT_EMAIL_TO)) {
      if (!recipients.some((r) => r.user.email === address)) await send(null, address, []);
    }
  }

  await db.update(notificationEvents).set({ processedAt: now }).where(eq(notificationEvents.id, event.id));
  if (event.alertId) {
    // The alert's email status, shown on the Alerts page.
    const emailStatus = !sender
      ? "not-configured"
      : results.length === 0
        ? "no-recipients"
        : results.includes("failed")
          ? "failed"
          : "sent";
    await db.update(alerts).set({ emailStatus, emailError: firstError }).where(eq(alerts.id, event.alertId));
  }
}

function withRules(message: EmailMessage, ruleNames: string[]): EmailMessage {
  if (ruleNames.length === 0) return message;
  return { ...message, text: message.text.replace("— VS Lab", `Your subscription${ruleNames.length > 1 ? "s" : ""}: ${ruleNames.join(", ")}\n\n— VS Lab`) };
}

async function eventEmail(db: Db, event: NotificationEvent, machine: { id: number; name: string; unitNumber: string | null }): Promise<EmailMessage> {
  const base = appUrl();
  const label = EVENT_TYPES[event.type as EventType]?.label ?? event.type;
  const [operator] = event.operatorId
    ? await db.select({ name: operators.name }).from(operators).where(eq(operators.id, event.operatorId))
    : [];
  const [alert] = event.alertId ? await db.select().from(alerts).where(eq(alerts.id, event.alertId)) : [];
  const machineName = machineLabel(machine);
  const lines = [
    alert ? alert.title : `${label}: ${machineName}`,
    "",
    alert?.detail ?? "",
    operator ? `Operator: ${operator.name}` : "",
    event.detail ?? "",
    "",
    base ? `Machine: ${base}/machines/${machine.id}` : "",
    alert && base ? `All alerts: ${base}/alerts` : "",
    base ? `Change your subscriptions: ${base}/alerts/subscriptions` : "",
    "",
    "— VS Lab",
  ];
  return {
    subject: alert ? `⚠ ${alert.title}` : `${label}: ${machineName}`,
    text: lines.filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n"),
  };
}

// ---------- Recent activity, for the subscriptions page ----------

/** The last day's events on machines the user can see, with which of their rules match and what was sent. */
export async function recentActivity(db: Db, user: { id: number; organizationId: number; role: Role }, hours = 24, limit = 40) {
  const scope = await scopeOfUser(db, user);
  const since = new Date(Date.now() - hours * 3_600_000);
  const [events, rules] = await Promise.all([
    db
      .select({ event: notificationEvents, machine: machines, operatorName: operators.name })
      .from(notificationEvents)
      .innerJoin(machines, eq(machines.id, notificationEvents.machineId))
      .leftJoin(operators, eq(operators.id, notificationEvents.operatorId))
      .where(and(eq(notificationEvents.organizationId, user.organizationId), gte(notificationEvents.occurredAt, since)))
      .orderBy(desc(notificationEvents.occurredAt))
      .limit(limit * 3),
    listRules(db, user.organizationId, user.id),
  ]);
  const visible = events.filter((e) => canSeeMachine(scope, e.machine)).slice(0, limit);
  const deliveries = visible.length
    ? await db
        .select()
        .from(notificationDeliveries)
        .where(and(eq(notificationDeliveries.userId, user.id), inArray(notificationDeliveries.eventId, visible.map((e) => e.event.id))))
    : [];
  const sent = new Map(deliveries.map((d) => [d.eventId, d]));
  return visible.map(({ event, machine, operatorName }) => ({
    id: event.id,
    type: event.type,
    label: EVENT_TYPES[event.type as EventType]?.label ?? event.type,
    machine: machineLabel(machine),
    operatorName,
    occurredAt: event.occurredAt,
    matchingRules: rules.filter((r) => ruleMatches(r, event, machine)).map((r) => r.name),
    delivery: sent.get(event.id) ?? null,
  }));
}
