import type { CachedRoad } from "@/lib/db/schema";
import { distanceM } from "@/lib/history-track";

/**
 * Posted speed limits, the pure part (docs/posted-speed-limits.md): reading OpenStreetMap's maxspeed tags, map
 * squares, matching GPS points to the road driven, finding spells over the limit and tallying road kilometres with
 * and without a known limit. The database and download side is src/lib/posted-speed.ts.
 */

export const ROAD_RULES = {
  /** Map squares are this many degrees on a side (about 5.5 km north–south). */
  tileDegrees: 0.05,
  /** A point further than this from any road is off-road (yard, worksite, field). */
  matchMeters: 25,
  /** Prefer the road matched just before, unless another is clearly closer (stops flicking between parallel roads). */
  stickyMeters: 8,
  /** Heading counts only when moving at least this fast (GPS heading is noise when slow). */
  headingMinKph: 10,
  /** Metres of matching penalty per degree the heading differs from the road. */
  headingPenaltyPerDegree: 0.25,
  /** A spell over the limit counts once it lasts this long (as for the fleet speed limit). */
  graceSeconds: 10,
  /** Readings further apart than this end a spell, and the distance between them isn't tallied. */
  maxGapSeconds: 60,
  minSatellites: 4,
  toleranceRange: [0, 50] as [number, number],
};

/** Starter machine categories that drive on public roads (the machine form ticks "On-road vehicle" for them). */
export const ON_ROAD_CATEGORIES = ["Pickup / light vehicle", "Dump truck (on-road)"];

/** OpenStreetMap highway types we match against (public roads; not service roads, tracks or paths). */
export const ROAD_TYPES = [
  "motorway",
  "trunk",
  "primary",
  "secondary",
  "tertiary",
  "unclassified",
  "residential",
  "living_street",
  "road",
  "motorway_link",
  "trunk_link",
  "primary_link",
  "secondary_link",
  "tertiary_link",
];

/**
 * An OpenStreetMap maxspeed value in km/h: "50", "50 km/h", "30 mph". Zone codes ("CA:urban"), "none", "signals"
 * and "walk" aren't a number, so they count as unknown (we don't guess).
 */
export function parseMaxspeed(tag: string | undefined | null): number | null {
  if (!tag) return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph)?\s*$/i.exec(tag.split(";")[0]);
  if (!m) return null;
  const n = Number(m[1]);
  if (!(n > 0 && n <= 200)) return null;
  return m[2]?.toLowerCase() === "mph" ? Math.round(n * 1.609344) : n;
}

/** A road from an Overpass answer (way with tags and geometry), or null if it isn't usable. */
export function roadFromOsm(way: { id: number; tags?: Record<string, string>; geometry?: { lat: number; lon: number }[] }): CachedRoad | null {
  const t = way.tags ?? {};
  if (!way.geometry || way.geometry.length < 2 || !ROAD_TYPES.includes(t.highway)) return null;
  const oneway = t.oneway === "yes" || t.oneway === "1" || t.oneway === "true" || t.highway === "motorway" ? 1 : t.oneway === "-1" || t.oneway === "reverse" ? -1 : 0;
  return {
    id: way.id,
    name: t.name ?? t.ref ?? null,
    highway: t.highway,
    oneway,
    limit: parseMaxspeed(t.maxspeed),
    forward: parseMaxspeed(t["maxspeed:forward"]),
    backward: parseMaxspeed(t["maxspeed:backward"]),
    points: way.geometry.map((g) => [Math.round(g.lat * 1e6) / 1e6, Math.round(g.lon * 1e6) / 1e6]),
  };
}

// ---------- map squares ----------

export function tileKey(lat: number, lng: number) {
  const d = ROAD_RULES.tileDegrees;
  return `${Math.floor(lat / d)}:${Math.floor(lng / d)}`;
}

/** South, west, north, east of a square. */
export function tileBounds(key: string): [number, number, number, number] {
  const d = ROAD_RULES.tileDegrees;
  const [y, x] = key.split(":").map(Number);
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(y * d), r(x * d), r((y + 1) * d), r((x + 1) * d)];
}

/** The squares a point needs: its own, plus neighbours when it's near an edge (a road just across the line). */
export function tilesNear(lat: number, lng: number): string[] {
  const pad = 0.0005; // ~55 m
  const padLng = pad / Math.cos((lat * Math.PI) / 180);
  const keys = new Set<string>();
  for (const dy of [-pad, 0, pad]) for (const dx of [-padLng, 0, padLng]) keys.add(tileKey(lat + dy, lng + dx));
  return [...keys];
}

// ---------- matching ----------

export type RoadPoint = { t: number; lat: number; lng: number; kph: number | null; heading: number | null; satellites: number | null };
export type Matched = RoadPoint & { road: CachedRoad | null; limit: number | null };

/** Metres from a point to a segment, and the segment's compass bearing (local flat approximation; fine at road scale). */
function toSegment(p: { lat: number; lng: number }, a: [number, number], b: [number, number]) {
  const k = Math.cos((p.lat * Math.PI) / 180);
  const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p.lng * k, py = p.lat;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  const meters = Math.hypot(px - (ax + u * dx), py - (ay + u * dy)) * 111_320;
  const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
  return { meters, bearing: (bearing + 360) % 360 };
}

const angleDiff = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** The limit for travel along a road at a heading: per-direction limits if tagged, else the road's. */
function directionalLimit(road: CachedRoad, alongPoints: boolean | null) {
  if (alongPoints === true && road.forward !== null) return road.forward;
  if (alongPoints === false && road.backward !== null) return road.backward;
  if (alongPoints === null && (road.forward !== null || road.backward !== null)) {
    const both = [road.forward, road.backward, road.limit].filter((v): v is number => v !== null);
    return Math.min(...both);
  }
  return road.limit;
}

/**
 * Matches each point to the road it was on: nearest road within matchMeters, penalised when the heading doesn't fit
 * the road (or goes the wrong way down a one-way), sticking to the previous road when it's about as close.
 */
export function matchToRoads(points: RoadPoint[], roads: CachedRoad[]): Matched[] {
  // Grid of ~110 m cells → the road segments passing through or near them, so each point checks only nearby roads.
  const CELL = 0.001;
  const grid = new Map<string, [CachedRoad, number][]>();
  for (const road of roads) {
    for (let i = 1; i < road.points.length; i++) {
      const [a, b] = [road.points[i - 1], road.points[i]];
      const steps = Math.max(1, Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])) / CELL));
      const cells = new Set<string>();
      for (let k = 0; k <= steps; k++) cells.add(`${Math.floor((a[0] + ((b[0] - a[0]) * k) / steps) / CELL)}:${Math.floor((a[1] + ((b[1] - a[1]) * k) / steps) / CELL)}`);
      for (const c of cells) {
        const list = grid.get(c);
        if (list) list.push([road, i]);
        else grid.set(c, [[road, i]]);
      }
    }
  }
  const nearby = (lat: number, lng: number) => {
    const [cy, cx] = [Math.floor(lat / CELL), Math.floor(lng / CELL)];
    const seen = new Set<string>();
    const out: [CachedRoad, number][] = [];
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++)
        for (const entry of grid.get(`${cy + dy}:${cx + dx}`) ?? []) {
          const id = `${entry[0].id}:${entry[1]}`;
          if (!seen.has(id)) {
            seen.add(id);
            out.push(entry);
          }
        }
    return out;
  };
  let prev: CachedRoad | null = null;
  return points.map((p) => {
    const useHeading = p.heading !== null && (p.kph ?? 0) >= ROAD_RULES.headingMinKph;
    let best: { road: CachedRoad; score: number; meters: number; along: boolean | null } | null = null;
    let prevScore: { road: CachedRoad; score: number; meters: number; along: boolean | null } | null = null;
    for (const [road, i] of nearby(p.lat, p.lng)) {
      const seg = toSegment(p, road.points[i - 1], road.points[i]);
      if (seg.meters > ROAD_RULES.matchMeters) continue;
      let penalty = 0;
      let along: boolean | null = null;
      if (useHeading) {
        const fwd = angleDiff(p.heading!, seg.bearing);
        along = fwd <= 90;
        const off = Math.min(fwd, 180 - fwd);
        penalty = off * ROAD_RULES.headingPenaltyPerDegree;
        if ((road.oneway === 1 && !along) || (road.oneway === -1 && along)) penalty += 30;
      }
      const score = seg.meters + penalty;
      const cand = { road, score, meters: seg.meters, along };
      if (!best || score < best.score) best = cand;
      if (prev && road.id === prev.id && (!prevScore || score < prevScore.score)) prevScore = cand;
    }
    const pick = prevScore && best && prevScore.score <= best.score + ROAD_RULES.stickyMeters ? prevScore : best;
    prev = pick?.road ?? null;
    return { ...p, road: pick?.road ?? null, limit: pick ? directionalLimit(pick.road, pick.along) : null };
  });
}

// ---------- speeding and coverage ----------

export type PostedSpell = { start: number; end: number; peak: number; limit: number; road: string | null; open: boolean };

/**
 * Spells of driving more than tolerancePct over the posted limit for at least graceSeconds. `open` = still going at
 * the last point (the caller re-checks it next time instead of recording half a spell).
 */
export function postedSpeedingSpells(points: Matched[], tolerancePct: number): PostedSpell[] {
  const spells: PostedSpell[] = [];
  let cur: PostedSpell | null = null;
  let last: Matched | null = null;
  const close = (open: boolean) => {
    if (cur && (open || cur.end - cur.start >= ROAD_RULES.graceSeconds * 1000)) spells.push({ ...cur, open });
    cur = null;
  };
  for (const p of points) {
    if (last && p.t - last.t > ROAD_RULES.maxGapSeconds * 1000) close(false);
    const trusted = p.kph !== null && (p.satellites === null || p.satellites >= ROAD_RULES.minSatellites);
    const over = trusted && p.limit !== null && p.kph! > p.limit * (1 + tolerancePct / 100);
    if (over) {
      if (!cur) cur = { start: p.t, end: p.t, peak: p.kph!, limit: p.limit!, road: p.road?.name ?? null, open: false };
      else {
        cur.end = p.t;
        if (p.kph! > cur.peak) cur.peak = p.kph!;
        // Report against the lowest limit in the spell (where it was most over).
        if (p.limit! < cur.limit) {
          cur.limit = p.limit!;
          cur.road = p.road?.name ?? cur.road;
        }
      }
    } else if (trusted) close(false);
    last = p;
  }
  if (cur) close(true);
  return spells;
}

/** Kilometres driven on roads with a known limit, on roads without one, and off-road. */
export function roadCoverageKm(points: Matched[]) {
  const km = { known: 0, unknown: 0, offRoad: 0 };
  for (let i = 1; i < points.length; i++) {
    const [a, b] = [points[i - 1], points[i]];
    if (b.t - a.t > ROAD_RULES.maxGapSeconds * 1000) continue;
    const d = distanceM(a, b) / 1000;
    if (d > 3) continue; // a jump, not driving
    if (!a.road) km.offRoad += d;
    else if (a.limit !== null) km.known += d;
    else km.unknown += d;
  }
  return km;
}
