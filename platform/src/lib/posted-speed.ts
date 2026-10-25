import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, machines, organizations, roadCoverage, roadTiles, safetyEvents, telemetry, type CachedRoad } from "@/lib/db/schema";
import { recordEvent } from "@/lib/notifications";
import { appTimeZone, localDateKey } from "@/lib/telemetry/engine";
import {
  matchToRoads,
  postedSpeedingSpells,
  roadCoverageKm,
  roadFromOsm,
  ROAD_TYPES,
  tileBounds,
  tilesNear,
  type RoadPoint,
} from "@/lib/road-limits";

/**
 * Posted speed limits for on-road vehicles (docs/posted-speed-limits.md). Every 5 minutes (Vercel Cron →
 * /api/jobs/posted-speed) each on-road machine's new telemetry is matched to OpenStreetMap roads, compared with the
 * road's posted limit plus the company's % tolerance, and spells over it go in the safety log ("posted_speeding")
 * with a notification. Road kilometres with/without a known limit are tallied per month (road_coverage).
 * Roads come from the public Overpass API in map squares, cached for a month and shared by all companies; only a
 * square's corners are sent, never a vehicle's position.
 */

export const POSTED_RULES = {
  refreshDays: 30,
  /** Map squares downloaded per run (Overpass is a shared free service: keep it light). */
  maxDownloadsPerRun: 3,
  downloadTimeoutMs: 25_000,
  /** How far back to start for a machine checked for the first time. */
  firstLookbackHours: 24,
  /** Most telemetry checked per machine per run. */
  maxWindowHours: 6,
  /** Leave the last few minutes for the next run (reports still arriving). */
  settleMinutes: 3,
};

const overpassUrl = () => process.env.OVERPASS_URL || "https://overpass-api.de/api/interpreter";

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Downloads the public roads in a map square from Overpass. Null if it failed (tried again next run). */
export async function downloadTile(key: string, fetchImpl: Fetch = fetch): Promise<CachedRoad[] | null> {
  const [s, w, n, e] = tileBounds(key);
  const query = `[out:json][timeout:25];way["highway"~"^(${ROAD_TYPES.join("|")})$"](${s},${w},${n},${e});out tags geom;`;
  try {
    const res = await fetchImpl(overpassUrl(), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "vs-lab-platform (Veristart equipment safety lab)" },
      body: `data=${encodeURIComponent(query)}`,
      signal: AbortSignal.timeout(POSTED_RULES.downloadTimeoutMs),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { elements?: Parameters<typeof roadFromOsm>[0][] };
    return (json.elements ?? []).map(roadFromOsm).filter((r): r is CachedRoad => r !== null);
  } catch {
    return null;
  }
}

/** Cached roads for the squares, downloading missing or stale ones while the run's budget lasts. */
async function roadsFor(db: Db, keys: string[], budget: { left: number }, now: Date, fetchImpl: Fetch) {
  const fresh = new Date(now.getTime() - POSTED_RULES.refreshDays * 86_400_000);
  const cached = keys.length ? await db.select().from(roadTiles).where(inArray(roadTiles.key, keys)) : [];
  const have = new Map(cached.filter((c) => c.fetchedAt >= fresh).map((c) => [c.key, c.roads]));
  const stale = new Map(cached.filter((c) => c.fetchedAt < fresh).map((c) => [c.key, c.roads]));
  for (const key of keys) {
    if (have.has(key)) continue;
    if (budget.left <= 0) {
      if (stale.has(key)) have.set(key, stale.get(key)!); // old map data beats none
      continue;
    }
    budget.left--;
    const roads = await downloadTile(key, fetchImpl);
    if (roads === null) {
      if (stale.has(key)) have.set(key, stale.get(key)!);
      continue;
    }
    await db
      .insert(roadTiles)
      .values({ key, fetchedAt: now, roads })
      .onConflictDoUpdate({ target: roadTiles.key, set: { fetchedAt: now, roads } });
    have.set(key, roads);
  }
  return have;
}

async function operatorAt(db: Db, machineId: number, at: Date) {
  const [row] = await db
    .select({ id: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.machineId, machineId), lte(checkins.startedAt, at), or(isNull(checkins.endedAt), gte(checkins.endedAt, at))))
    .limit(1);
  return row?.id ?? null;
}

/** One run over every on-road machine of companies that use posted limits. Returns the spells recorded. */
export async function checkPostedSpeeds(db: Db, now = new Date(), fetchImpl: Fetch = fetch): Promise<number> {
  const rows = await db
    .select({ machine: machines, tolerance: organizations.postedLimitTolerancePct })
    .from(machines)
    .innerJoin(organizations, eq(organizations.id, machines.organizationId))
    .where(and(eq(machines.onRoad, true), isNotNull(organizations.postedLimitTolerancePct)));
  const budget = { left: POSTED_RULES.maxDownloadsPerRun };
  const tz = appTimeZone();
  let recorded = 0;
  for (const { machine, tolerance } of rows) {
    const from = machine.roadCheckedUntil ?? new Date(now.getTime() - POSTED_RULES.firstLookbackHours * 3_600_000);
    const to = new Date(Math.min(now.getTime() - POSTED_RULES.settleMinutes * 60_000, from.getTime() + POSTED_RULES.maxWindowHours * 3_600_000));
    if (to <= from) continue;
    const data = await db
      .select({ at: telemetry.receivedAt, lat: telemetry.lat, lng: telemetry.lng, kph: telemetry.speedKph, heading: telemetry.heading, satellites: telemetry.satellites })
      .from(telemetry)
      .where(
        and(
          eq(telemetry.machineId, machine.id),
          gte(telemetry.receivedAt, from),
          lt(telemetry.receivedAt, to),
          isNotNull(telemetry.lat),
          isNotNull(telemetry.lng),
          sql`not (${telemetry.lat} = 0 and ${telemetry.lng} = 0)`,
        ),
      )
      .orderBy(asc(telemetry.receivedAt));
    const points: RoadPoint[] = data.map((d) => ({ t: d.at.getTime(), lat: d.lat!, lng: d.lng!, kph: d.kph, heading: d.heading, satellites: d.satellites }));
    let until = to.getTime();
    if (points.length) {
      // Roads for each point's squares; stop at the first point whose map data isn't available yet.
      const needed = [...new Set(points.flatMap((p) => tilesNear(p.lat, p.lng)))];
      const tiles = await roadsFor(db, needed, budget, now, fetchImpl);
      const firstMissing = points.findIndex((p) => tilesNear(p.lat, p.lng).some((k) => !tiles.has(k)));
      const usable = firstMissing === -1 ? points : points.slice(0, firstMissing);
      if (firstMissing !== -1) until = points[firstMissing].t;
      if (!usable.length) continue; // nothing checkable yet: wait for the map data
      const roads = [...new Map([...tiles.values()].flat().map((r) => [r.id, r])).values()];
      const matched = matchToRoads(usable, roads);
      const spells = postedSpeedingSpells(matched, tolerance!);
      // A spell still going at the end is checked again next time, from its start, unless it began right at the
      // start of this window (then waiting would never move forward, so it's recorded as it stands).
      const open = spells.find((s) => s.open);
      if (open && open.start > from.getTime()) until = Math.min(until, open.start);
      for (const spell of spells.filter((s) => s.start < until && (!s.open || s.start <= from.getTime()))) {
        const start = new Date(spell.start);
        const operatorId = await operatorAt(db, machine.id, start);
        const detail = `${Math.round(spell.peak)} km/h in a ${spell.limit} km/h zone${spell.road ? ` on ${spell.road}` : ""} (posted limit + ${tolerance}% tolerance; OpenStreetMap).`;
        const [row] = await db
          .insert(safetyEvents)
          .values({
            organizationId: machine.organizationId,
            machineId: machine.id,
            operatorId,
            kind: "posted_speeding",
            startedAt: start,
            endedAt: new Date(spell.end),
            peak: spell.peak,
            limitValue: spell.limit,
            detail,
            notifiedAt: now,
            dedupeKey: `posted:${machine.id}:${spell.start}`,
          })
          .onConflictDoNothing()
          .returning({ id: safetyEvents.id });
        if (!row) continue;
        recorded++;
        await recordEvent(db, {
          organizationId: machine.organizationId,
          machineId: machine.id,
          type: "posted_speeding",
          operatorId,
          detail,
          occurredAt: start,
        });
      }
      // Kilometres by month, for the points now done.
      const done = matched.filter((p) => p.t < until);
      const byMonth = Map.groupBy(done, (p) => localDateKey(p.t, tz).slice(0, 7));
      for (const [month, monthPoints] of byMonth) {
        const km = roadCoverageKm(monthPoints);
        if (km.known + km.unknown + km.offRoad === 0) continue;
        await db
          .insert(roadCoverage)
          .values({ organizationId: machine.organizationId, month, knownKm: km.known, unknownKm: km.unknown, offRoadKm: km.offRoad })
          .onConflictDoUpdate({
            target: [roadCoverage.organizationId, roadCoverage.month],
            set: {
              knownKm: sql`${roadCoverage.knownKm} + ${km.known}`,
              unknownKm: sql`${roadCoverage.unknownKm} + ${km.unknown}`,
              offRoadKm: sql`${roadCoverage.offRoadKm} + ${km.offRoad}`,
            },
          });
      }
    }
    if (until > from.getTime()) await db.update(machines).set({ roadCheckedUntil: new Date(until) }).where(eq(machines.id, machine.id));
  }
  return recorded;
}

/** Road kilometres per month with and without a known posted limit (Settings), newest first. */
export async function roadCoverageByMonth(db: Db, organizationId: number, months = 12) {
  return db
    .select()
    .from(roadCoverage)
    .where(eq(roadCoverage.organizationId, organizationId))
    .orderBy(sql`${roadCoverage.month} desc`)
    .limit(months);
}

/** For a quick total: are there any on-road machines in the company? */
export async function onRoadMachineCount(db: Db, organizationId: number) {
  const [row] = await db
    .select({ n: sql<number>`count(*)` })
    .from(machines)
    .where(and(eq(machines.organizationId, organizationId), eq(machines.onRoad, true)));
  return Number(row?.n ?? 0);
}
