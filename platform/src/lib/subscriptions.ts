import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alertSubscriptions, divisions, machines, userDivisions, users, type Role } from "@/lib/db/schema";
import { ALERT_LABELS, type AlertType } from "@/lib/alerts";
import { canSeeMachine, type Scope } from "@/lib/divisions";
import { machineLabel } from "@/lib/format";

/**
 * Alert subscriptions: which alerts each user is sent, for which machines, and how. A subscription is
 * an alert type (or all types) for all the machines the user can see, one division, or one machine.
 * Users are only ever sent alerts for machines they can see, whatever they subscribe to.
 * Plain functions that take the database, so they can be tested without a server.
 */

export class SubscriptionError extends Error {}

/** How alerts are delivered. Only email for now; text messages and app notifications can be added here. */
export const ALERT_CHANNELS = { email: "Email" } as const;
export type AlertChannel = keyof typeof ALERT_CHANNELS;

export type SubscriptionInput = {
  /** null = every alert type */
  type: AlertType | null;
  divisionId: number | null;
  machineId: number | null;
  channel: AlertChannel;
};

/** New owners and managers get every alert by email (they can change it). Viewers start with none. */
export async function addDefaultSubscriptions(db: Db, userId: number, role: Role) {
  if (role === "viewer") return;
  await db.insert(alertSubscriptions).values({ userId, channel: "email" });
}

/** What a user can see, for checking subscriptions and deliveries (the same rules as signing in). */
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
  if (!user) throw new SubscriptionError("User not found.");
  return user;
}

/** A user's subscriptions, with readable descriptions. */
export async function listSubscriptions(db: Db, organizationId: number, userId: number) {
  await userInOrg(db, organizationId, userId);
  const rows = await db
    .select({
      subscription: alertSubscriptions,
      divisionName: divisions.name,
      machineName: machines.name,
      unitNumber: machines.unitNumber,
    })
    .from(alertSubscriptions)
    .leftJoin(divisions, eq(divisions.id, alertSubscriptions.divisionId))
    .leftJoin(machines, eq(machines.id, alertSubscriptions.machineId))
    .where(eq(alertSubscriptions.userId, userId))
    .orderBy(asc(alertSubscriptions.id));
  return rows.map((r) => ({
    ...r.subscription,
    what: r.subscription.type ? (ALERT_LABELS[r.subscription.type as AlertType] ?? r.subscription.type) : "All alerts",
    where: r.machineName
      ? machineLabel({ name: r.machineName, unitNumber: r.unitNumber })
      : r.divisionName
        ? `${r.divisionName} division`
        : "All machines",
    how: ALERT_CHANNELS[r.subscription.channel as AlertChannel] ?? r.subscription.channel,
  }));
}

export async function addSubscription(db: Db, organizationId: number, userId: number, input: SubscriptionInput) {
  const user = await userInOrg(db, organizationId, userId);
  if (input.type !== null && !(input.type in ALERT_LABELS)) throw new SubscriptionError("Unknown alert type.");
  if (!(input.channel in ALERT_CHANNELS)) throw new SubscriptionError("Unknown delivery method.");
  if (input.divisionId && input.machineId) throw new SubscriptionError("Choose a division or a machine, not both.");
  const scope = await scopeOfUser(db, user);

  if (input.divisionId) {
    const [division] = await db
      .select({ id: divisions.id })
      .from(divisions)
      .where(and(eq(divisions.id, input.divisionId), eq(divisions.organizationId, organizationId)));
    if (!division) throw new SubscriptionError("Division not found.");
    if (scope.divisionIds && !scope.divisionIds.includes(input.divisionId)) {
      throw new SubscriptionError("This user can't see that division's machines.");
    }
  }
  if (input.machineId) {
    const [machine] = await db.select().from(machines).where(eq(machines.id, input.machineId));
    if (!machine || machine.organizationId !== organizationId) throw new SubscriptionError("Machine not found.");
    if (!canSeeMachine(scope, machine)) throw new SubscriptionError("This user can't see that machine.");
  }

  const existing = await db.select().from(alertSubscriptions).where(eq(alertSubscriptions.userId, userId));
  const same = existing.some(
    (s) =>
      s.type === input.type &&
      s.divisionId === input.divisionId &&
      s.machineId === input.machineId &&
      s.channel === input.channel,
  );
  if (same) throw new SubscriptionError("That subscription already exists.");
  const [row] = await db
    .insert(alertSubscriptions)
    .values({ userId, type: input.type, divisionId: input.divisionId, machineId: input.machineId, channel: input.channel })
    .returning();
  return row;
}

export async function removeSubscription(db: Db, organizationId: number, userId: number, subscriptionId: number) {
  await userInOrg(db, organizationId, userId);
  await db
    .delete(alertSubscriptions)
    .where(and(eq(alertSubscriptions.id, subscriptionId), eq(alertSubscriptions.userId, userId)));
}

/**
 * Email addresses to send an alert to: active users of the machine's organization with a matching email
 * subscription, who can see the machine.
 */
export async function subscribersFor(db: Db, alert: { type: string; machineId: number }): Promise<string[]> {
  const [machine] = await db.select().from(machines).where(eq(machines.id, alert.machineId));
  if (!machine) return [];
  const rows = await db
    .select({ subscription: alertSubscriptions, user: users })
    .from(alertSubscriptions)
    .innerJoin(users, eq(users.id, alertSubscriptions.userId))
    .where(
      and(eq(users.organizationId, machine.organizationId), eq(users.active, true), eq(alertSubscriptions.channel, "email")),
    );
  const matching = rows.filter(({ subscription: s }) => {
    if (s.type !== null && s.type !== alert.type) return false;
    if (s.machineId !== null) return s.machineId === machine.id;
    if (s.divisionId !== null) return s.divisionId === machine.divisionId;
    return true;
  });
  if (matching.length === 0) return [];

  // Only people who can see the machine (division limits apply to alerts too).
  const people = [...new Map(matching.map((r) => [r.user.id, r.user])).values()];
  const limits = await db
    .select({ userId: userDivisions.userId, divisionId: userDivisions.divisionId })
    .from(userDivisions)
    .where(inArray(userDivisions.userId, people.map((p) => p.id)));
  const byUser = Map.groupBy(limits, (l) => l.userId);
  return people
    .filter((p) => {
      const mine = byUser.get(p.id);
      const scope: Scope = {
        organizationId: p.organizationId,
        divisionIds: p.role === "owner" || !mine ? null : mine.map((l) => l.divisionId),
      };
      return canSeeMachine(scope, machine);
    })
    .map((p) => p.email);
}
