import { and, eq, inArray, ne, type SQL } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, checkins, divisions, machines, userDivisions, users } from "@/lib/db/schema";

/**
 * Divisions: optional sub-groups of an organization, one level only. A machine is in one division or
 * none. A user can be limited to some divisions; then they only see those divisions' machines and the
 * check-ins and alerts on them. Users with no divisions ticked, and owners, see the whole organization.
 * Operators belong to the whole organization (people move between divisions).
 * Plain functions that take the database, so they can be tested without a server.
 */

export class DivisionError extends Error {}

/** What a signed-in user can see: their organization, limited to some divisions (null = all of it). */
export type Scope = { organizationId: number; divisionIds: number[] | null };

/** Condition for "machines this user can see". Use it in every machine query for pages. */
export function machineScope(scope: Scope): SQL {
  return and(
    eq(machines.organizationId, scope.organizationId),
    scope.divisionIds ? inArray(machines.divisionId, scope.divisionIds) : undefined,
  )!;
}

export function canSeeMachine(scope: Scope, machine: { organizationId: number; divisionId: number | null }): boolean {
  if (machine.organizationId !== scope.organizationId) return false;
  return !scope.divisionIds || (machine.divisionId !== null && scope.divisionIds.includes(machine.divisionId));
}

/** For actions on a machine: throws unless the user can see it. */
export async function assertMachineInScope(db: Db, scope: Scope, machineId: number) {
  const [machine] = await db.select().from(machines).where(and(eq(machines.id, machineId), machineScope(scope)));
  if (!machine) throw new DivisionError("Machine not found.");
  return machine;
}

/** For actions on a check-in or alert: throws unless it's on a machine the user can see. */
export async function assertCheckinInScope(db: Db, scope: Scope, checkinId: number) {
  const [row] = await db
    .select({ id: checkins.id })
    .from(checkins)
    .innerJoin(machines, eq(machines.id, checkins.machineId))
    .where(and(eq(checkins.id, checkinId), eq(checkins.organizationId, scope.organizationId), machineScope(scope)));
  if (!row) throw new DivisionError("Check-in not found.");
}

export async function assertAlertInScope(db: Db, scope: Scope, alertId: number) {
  const [row] = await db
    .select({ id: alerts.id })
    .from(alerts)
    .innerJoin(machines, eq(machines.id, alerts.machineId))
    .where(and(eq(alerts.id, alertId), eq(alerts.organizationId, scope.organizationId), machineScope(scope)));
  if (!row) throw new DivisionError("Alert not found.");
}

/**
 * Which division a user may put a machine in. Limited users must pick one of their own divisions
 * (otherwise they'd lose sight of the machine); whole-organization users may pick any, or none.
 */
export async function assertDivisionChoice(db: Db, scope: Scope, divisionId: number | null) {
  if (divisionId === null) {
    if (scope.divisionIds) throw new DivisionError("Choose one of your divisions.");
    return;
  }
  if (scope.divisionIds && !scope.divisionIds.includes(divisionId)) throw new DivisionError("Choose one of your divisions.");
  const [division] = await db
    .select({ id: divisions.id })
    .from(divisions)
    .where(and(eq(divisions.id, divisionId), eq(divisions.organizationId, scope.organizationId)));
  if (!division) throw new DivisionError("Division not found.");
}

// ---------- Managing divisions (owners) ----------

async function assertNameFree(db: Db, organizationId: number, name: string, exceptId?: number) {
  const [taken] = await db
    .select({ id: divisions.id })
    .from(divisions)
    .where(and(eq(divisions.organizationId, organizationId), eq(divisions.name, name), exceptId ? ne(divisions.id, exceptId) : undefined));
  if (taken) throw new DivisionError(`There's already a division called ${name}.`);
}

export async function createDivision(db: Db, organizationId: number, rawName: string) {
  const name = rawName.trim();
  if (!name) throw new DivisionError("Enter the division's name.");
  await assertNameFree(db, organizationId, name);
  const [division] = await db.insert(divisions).values({ organizationId, name }).returning();
  return division;
}

export async function renameDivision(db: Db, organizationId: number, divisionId: number, rawName: string) {
  const name = rawName.trim();
  if (!name) throw new DivisionError("Enter the division's name.");
  await assertNameFree(db, organizationId, name, divisionId);
  const updated = await db
    .update(divisions)
    .set({ name })
    .where(and(eq(divisions.id, divisionId), eq(divisions.organizationId, organizationId)))
    .returning({ id: divisions.id });
  if (updated.length === 0) throw new DivisionError("Division not found.");
}

/**
 * Only an empty division can be deleted: machines must be moved out first, and so must users limited
 * to it (deleting it under them could silently widen what they see).
 */
export async function deleteDivision(db: Db, organizationId: number, divisionId: number) {
  const [division] = await db
    .select()
    .from(divisions)
    .where(and(eq(divisions.id, divisionId), eq(divisions.organizationId, organizationId)));
  if (!division) throw new DivisionError("Division not found.");
  const [machine] = await db.select({ id: machines.id }).from(machines).where(eq(machines.divisionId, divisionId)).limit(1);
  if (machine) throw new DivisionError(`${division.name} still has machines. Move them to another division first.`);
  const [user] = await db.select({ id: userDivisions.userId }).from(userDivisions).where(eq(userDivisions.divisionId, divisionId)).limit(1);
  if (user) throw new DivisionError(`Some users are limited to ${division.name}. Change their access first.`);
  await db.delete(divisions).where(eq(divisions.id, divisionId));
}

/** Limits a user to some divisions (empty list = the whole organization). Owners always see everything. */
export async function setUserDivisions(db: Db, organizationId: number, userId: number, divisionIds: number[]) {
  const [user] = await db
    .select()
    .from(users)
    .where(and(eq(users.id, userId), eq(users.organizationId, organizationId)));
  if (!user) throw new DivisionError("User not found.");
  const valid = divisionIds.length
    ? await db
        .select({ id: divisions.id })
        .from(divisions)
        .where(and(eq(divisions.organizationId, organizationId), inArray(divisions.id, divisionIds)))
    : [];
  if (valid.length !== new Set(divisionIds).size) throw new DivisionError("Division not found.");
  await db.transaction(async (tx) => {
    await tx.delete(userDivisions).where(eq(userDivisions.userId, userId));
    if (valid.length) await tx.insert(userDivisions).values(valid.map((d) => ({ userId, divisionId: d.id })));
  });
}

/**
 * Users who should hear about a machine: active owners and managers of its organization, except managers
 * limited to other divisions.
 */
export async function usersForMachine(db: Db, machine: { organizationId: number; divisionId: number | null }) {
  const people = await db
    .select({ id: users.id, email: users.email, role: users.role })
    .from(users)
    .where(and(eq(users.organizationId, machine.organizationId), eq(users.active, true), inArray(users.role, ["owner", "manager"])));
  if (people.length === 0) return [];
  const limits = await db
    .select({ userId: userDivisions.userId, divisionId: userDivisions.divisionId })
    .from(userDivisions)
    .where(inArray(userDivisions.userId, people.map((p) => p.id)));
  const byUser = Map.groupBy(limits, (l) => l.userId);
  return people.filter((p) => {
    const mine = byUser.get(p.id);
    return p.role === "owner" || !mine || (machine.divisionId !== null && mine.some((l) => l.divisionId === machine.divisionId));
  });
}
