import { and, asc, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { orgTimeZone } from "@/lib/org-time";
import type { Db } from "@/lib/db";
import { checkins, worksites, worksiteVisits, type Worksite } from "@/lib/db/schema";
import { clockTime, formatHours } from "@/lib/format";
import { recordEvent } from "@/lib/notifications";
import { centroid, checkPolygon, distanceToEdgeM, isWorksiteType, pointInPolygon, WORKSITE_TYPES, type WorksiteType } from "@/lib/worksite-types";

/**
 * Worksites ("geo-lock"): places drawn on the map, and which machines are in them. Each GPS fix from a
 * machine's device updates its visits (enter / leave), and the watchdog checks for machines that have
 * stayed longer than a site's limit. Each produces a notification event that subscriptions can pick up.
 * Geometry and site kinds: src/lib/worksite-types.ts. See docs/worksites.md.
 */

export class WorksiteError extends Error {}

export const WORKSITE_RULES = {
  /**
   * A machine only counts as having left once it's this far outside the boundary, so GPS wobble along
   * an edge (a few metres either way) doesn't produce a stream of enter/leave pairs.
   */
  exitBufferM: 30,
  /** Fixes from fewer satellites than this are too rough to use. */
  minSatellites: 4,
  /** Longest "stays too long" limit: 30 days. */
  maxDwellMinutes: 30 * 24 * 60,
};

export type WorksiteInput = {
  name: string;
  type: string;
  notes: string;
  /** Minutes, or null for no limit. */
  dwellLimitMinutes: number | null;
  /** km/h, or null/absent for none (the fleet limit applies). */
  speedLimitKph?: number | null;
};

function cleanInput(input: WorksiteInput) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new WorksiteError("Enter a name.");
  if (!isWorksiteType(input.type)) throw new WorksiteError("Choose a type.");
  const dwell = input.dwellLimitMinutes;
  if (dwell !== null && (!Number.isInteger(dwell) || dwell < 5 || dwell > WORKSITE_RULES.maxDwellMinutes)) {
    throw new WorksiteError("The time limit must be between 5 minutes and 30 days.");
  }
  return { name, type: input.type, notes: input.notes.trim().slice(0, 500) || null, dwellLimitMinutes: dwell, speedLimitKph: input.speedLimitKph ?? null };
}

function shape(polygon: unknown) {
  const checked = checkPolygon(polygon);
  if (!checked.ok) throw new WorksiteError(checked.error);
  const c = centroid(checked.polygon);
  return { polygon: checked.polygon, centerLat: c.lat, centerLng: c.lng };
}

async function assertNameFree(db: Db, organizationId: number, name: string, exceptId?: number) {
  const [taken] = await db
    .select({ id: worksites.id })
    .from(worksites)
    .where(and(eq(worksites.organizationId, organizationId), eq(worksites.name, name)));
  if (taken && taken.id !== exceptId) throw new WorksiteError(`There's already a worksite called "${name}".`);
}

export async function createWorksite(db: Db, organizationId: number, userId: number | null, input: WorksiteInput & { polygon: unknown }) {
  const values = cleanInput(input);
  await assertNameFree(db, organizationId, values.name);
  const [site] = await db
    .insert(worksites)
    .values({ organizationId, createdByUserId: userId, ...values, ...shape(input.polygon) })
    .returning();
  return site;
}

async function findWorksite(db: Db, organizationId: number, id: number) {
  const [site] = await db.select().from(worksites).where(and(eq(worksites.id, id), eq(worksites.organizationId, organizationId)));
  if (!site) throw new WorksiteError("Worksite not found.");
  return site;
}

export async function updateWorksite(db: Db, organizationId: number, id: number, input: WorksiteInput) {
  await findWorksite(db, organizationId, id);
  const values = cleanInput(input);
  await assertNameFree(db, organizationId, values.name, id);
  await db.update(worksites).set({ ...values, updatedAt: new Date() }).where(eq(worksites.id, id));
}

/** A new boundary. Machines' visits catch up with it at their next GPS fix. */
export async function setWorksitePerimeter(db: Db, organizationId: number, id: number, polygon: unknown) {
  await findWorksite(db, organizationId, id);
  await db.update(worksites).set({ ...shape(polygon), updatedAt: new Date() }).where(eq(worksites.id, id));
}

/** Deletes the site and its visit history (past notifications stay, without the link). */
export async function deleteWorksite(db: Db, organizationId: number, id: number) {
  await findWorksite(db, organizationId, id);
  await db.delete(worksites).where(eq(worksites.id, id));
}

const typeLabel = (site: Pick<Worksite, "type">) => WORKSITE_TYPES[site.type as WorksiteType]?.label ?? site.type;

/** The operator checked in on the machine right now, if any (for the notification's operator filter). */
export async function currentOperatorId(db: Db, machineId: number): Promise<number | null> {
  const [open] = await db
    .select({ operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.machineId, machineId), isNull(checkins.endedAt)));
  return open?.operatorId ?? null;
}

/**
 * Updates which worksites a machine is in, from a GPS fix. Opens a visit (and an "entered" event) when
 * it's inside a site it wasn't in, and closes it (with a "left" event) once it's more than
 * WORKSITE_RULES.exitBufferM outside. Sites may overlap: a machine can be in several at once.
 * Returns the number of events recorded.
 */
export async function updatePresence(
  db: Db,
  machine: { id: number; organizationId: number },
  fix: { lat: number; lng: number; satellites?: number | null },
  at = new Date(),
): Promise<number> {
  if (fix.satellites !== null && fix.satellites !== undefined && fix.satellites < WORKSITE_RULES.minSatellites) return 0;
  const [sites, open] = await Promise.all([
    db.select().from(worksites).where(eq(worksites.organizationId, machine.organizationId)),
    db.select().from(worksiteVisits).where(and(eq(worksiteVisits.machineId, machine.id), isNull(worksiteVisits.leftAt))),
  ]);
  if (sites.length === 0 && open.length === 0) return 0;
  let events = 0;
  let operatorId: number | null | undefined;
  const operator = async () => (operatorId === undefined ? (operatorId = await currentOperatorId(db, machine.id)) : operatorId);

  for (const site of sites) {
    const inside = pointInPolygon(fix.lat, fix.lng, site.polygon);
    const visit = open.find((v) => v.worksiteId === site.id);
    if (inside && visit) {
      await db.update(worksiteVisits).set({ lastInsideAt: at }).where(eq(worksiteVisits.id, visit.id));
    } else if (inside) {
      const [created] = await db
        .insert(worksiteVisits)
        .values({ organizationId: machine.organizationId, machineId: machine.id, worksiteId: site.id, enteredAt: at, lastInsideAt: at })
        .onConflictDoNothing()
        .returning();
      if (created) {
        const id = await recordEvent(db, {
          organizationId: machine.organizationId,
          machineId: machine.id,
          type: "worksite_enter",
          worksiteId: site.id,
          worksiteVisitId: created.id,
          operatorId: await operator(),
          detail: `Entered "${site.name}" (${typeLabel(site)}).`,
          occurredAt: at,
        });
        if (id) events++;
      }
    } else if (visit && distanceToEdgeM(fix.lat, fix.lng, site.polygon) > WORKSITE_RULES.exitBufferM) {
      await db.update(worksiteVisits).set({ leftAt: at }).where(eq(worksiteVisits.id, visit.id));
      const hours = (at.getTime() - visit.enteredAt.getTime()) / 3_600_000;
      const id = await recordEvent(db, {
        organizationId: machine.organizationId,
        machineId: machine.id,
        type: "worksite_leave",
        worksiteId: site.id,
        worksiteVisitId: visit.id,
        operatorId: await operator(),
        detail: `Left "${site.name}" (${typeLabel(site)}) after ${formatHours(hours)}.`,
        occurredAt: at,
      });
      if (id) events++;
    }
  }
  return events;
}

/**
 * "Stays too long": records one event per visit that has gone past its site's time limit. Runs from the
 * watchdog (every 5 minutes) and after each device report. Returns the number of events recorded.
 */
export async function checkDwell(db: Db, now = new Date(), machineId?: number): Promise<number> {
  const overdue = await db
    .select({ visit: worksiteVisits, site: worksites })
    .from(worksiteVisits)
    .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
    .where(
      and(
        isNull(worksiteVisits.leftAt),
        isNull(worksiteVisits.dwellNotifiedAt),
        isNotNull(worksites.dwellLimitMinutes),
        lte(worksiteVisits.enteredAt, sql`${now.toISOString()}::timestamptz - make_interval(mins => ${worksites.dwellLimitMinutes})`),
        machineId ? eq(worksiteVisits.machineId, machineId) : undefined,
      ),
    );
  let events = 0;
  for (const { visit, site } of overdue) {
    const claimed = await db
      .update(worksiteVisits)
      .set({ dwellNotifiedAt: now })
      .where(and(eq(worksiteVisits.id, visit.id), isNull(worksiteVisits.dwellNotifiedAt)))
      .returning({ id: worksiteVisits.id });
    if (claimed.length === 0) continue;
    const id = await recordEvent(db, {
      organizationId: visit.organizationId,
      machineId: visit.machineId,
      type: "worksite_dwell",
      worksiteId: site.id,
      worksiteVisitId: visit.id,
      operatorId: await currentOperatorId(db, visit.machineId),
      detail: `Has been at "${site.name}" for more than ${formatHours(site.dwellLimitMinutes! / 60)} (since ${clockTime(visit.enteredAt, await orgTimeZone(db, visit.organizationId), now.getTime())}).`,
      occurredAt: now,
    });
    if (id) events++;
  }
  return events;
}

/** The sites a machine is in right now (open visits), for the machine page. */
export async function currentWorksites(db: Db, machineId: number) {
  return db
    .select({ visit: worksiteVisits, site: worksites })
    .from(worksiteVisits)
    .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
    .where(and(eq(worksiteVisits.machineId, machineId), isNull(worksiteVisits.leftAt)))
    .orderBy(asc(worksiteVisits.enteredAt));
}
