import { zonedToUtc } from "@/lib/schedule-time";

/**
 * Location history and battery history: time ranges and track maths (docs/location-history.md).
 * Pure and browser-safe: the replay screen uses the same helpers.
 */

// ---------- time ranges ----------

export const HISTORY_PRESETS = {
  "1h": "Last hour",
  "8h": "Last 8 hours",
  "24h": "Last 24 hours",
  today: "Today",
  yesterday: "Yesterday",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
} as const;
export type HistoryPreset = keyof typeof HISTORY_PRESETS | "custom";
/** The longest range one request covers (longer ranges are thinned out too much to be useful). */
export const HISTORY_MAX_DAYS = 31;

export type HistoryRange = {
  preset: HistoryPreset;
  from: number;
  to: number;
  label: string;
  /** For the custom range inputs ("YYYY-MM-DDTHH:mm" in the company time zone). */
  fromInput: string;
  toInput: string;
};

/** "YYYY-MM-DDTHH:mm" for an instant in a time zone (the value a datetime-local input takes). */
export function localInputValue(ms: number, timeZone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(ms))
      .map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

const INPUT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The range chosen with ?range= (and ?from=&to= for custom), in the company time zone. */
export function historyRange(
  params: { range?: string; from?: string; to?: string },
  now: number,
  timeZone: string,
  fallback: keyof typeof HISTORY_PRESETS = "24h",
): HistoryRange {
  const today = localInputValue(now, timeZone).slice(0, 10);
  const midnight = (date: string) => zonedToUtc(date, "00:00", timeZone);
  const preset: HistoryPreset = params.range && (params.range in HISTORY_PRESETS || params.range === "custom") ? (params.range as HistoryPreset) : fallback;
  let from: number;
  let to = now;
  switch (preset) {
    case "1h":
      from = now - HOUR;
      break;
    case "8h":
      from = now - 8 * HOUR;
      break;
    case "24h":
      from = now - DAY;
      break;
    case "today":
      from = midnight(today);
      break;
    case "yesterday":
      to = midnight(today);
      from = midnight(localInputValue(to - HOUR, timeZone).slice(0, 10));
      break;
    case "7d":
      from = now - 7 * DAY;
      break;
    case "30d":
      from = now - 30 * DAY;
      break;
    case "custom": {
      const a = INPUT.exec(params.from ?? "");
      const b = INPUT.exec(params.to ?? "");
      if (!a || !b) return historyRange({ range: fallback }, now, timeZone, fallback);
      let start = zonedToUtc(a[1], a[2], timeZone);
      let end = zonedToUtc(b[1], b[2], timeZone);
      if (start > end) [start, end] = [end, start];
      end = Math.min(end, now);
      if (start >= end) start = end - HOUR;
      if (end - start > HISTORY_MAX_DAYS * DAY) start = end - HISTORY_MAX_DAYS * DAY;
      from = start;
      to = end;
      break;
    }
  }
  const fmt = (ms: number) =>
    new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(ms));
  return {
    preset,
    from,
    to,
    label: preset === "custom" ? `${fmt(from)} – ${fmt(to)}` : HISTORY_PRESETS[preset],
    fromInput: localInputValue(from, timeZone),
    toInput: localInputValue(to, timeZone),
  };
}

// ---------- track ----------

export type TrackPoint = { t: number; lat: number; lng: number; kph: number | null; heading: number | null; engineOn: boolean | null };

export const TRACK_RULES = {
  /** A point that needs a faster speed than this to reach from its neighbours is a GPS glitch. */
  maxPlausibleKph: 250,
  /** The line breaks where the device was silent this long and the machine reappears somewhere else. */
  gapMinutes: 15,
  gapMeters: 300,
  /** A stop: the machine stayed within this distance for at least this long (engine on or off). */
  stopRadiusM: 60,
  stopMinutes: 5,
};

export function distanceM(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const kphBetween = (a: TrackPoint, b: TrackPoint) => {
  const hours = Math.abs(b.t - a.t) / HOUR;
  return hours === 0 ? (distanceM(a, b) > 50 ? Infinity : 0) : distanceM(a, b) / 1000 / hours;
};

/** Drops lone GPS glitches: a point that jumps away from both neighbours faster than any machine moves. */
export function dropOutliers(points: TrackPoint[]): TrackPoint[] {
  return points.filter((p, i) => {
    const prev = points[i - 1];
    const next = points[i + 1];
    if (!prev || !next) return true;
    const max = TRACK_RULES.maxPlausibleKph;
    return !(kphBetween(prev, p) > max && kphBetween(p, next) > max && kphBetween(prev, next) <= max);
  });
}

/** Splits the track where the device went quiet and the machine turned up elsewhere (we don't know the way it went). */
export function splitSegments(points: TrackPoint[]): TrackPoint[][] {
  const segments: TrackPoint[][] = [];
  let current: TrackPoint[] = [];
  for (const p of points) {
    const prev = current.at(-1);
    if (prev && p.t - prev.t > TRACK_RULES.gapMinutes * 60_000 && distanceM(prev, p) > TRACK_RULES.gapMeters) {
      segments.push(current);
      current = [];
    }
    current.push(p);
  }
  if (current.length) segments.push(current);
  return segments;
}

export type Stop = {
  lat: number;
  lng: number;
  start: number;
  end: number;
  minutes: number;
  /** Minutes with the engine on (working in place or idling). */
  engineMinutes: number;
  /** Minutes with the engine on and not moving. */
  idleMinutes: number;
};

/** Time between two readings counts for engine/idle minutes only up to this (longer = device asleep, unknown). */
const MAX_COUNTED_GAP = 5 * 60_000;

/**
 * Places where the machine stayed put for a while. A parked device goes quiet, so a stop is usually the last point
 * before it parked and the first after it woke, in the same place.
 */
export function findStops(points: TrackPoint[]): Stop[] {
  const stops: Stop[] = [];
  let i = 0;
  while (i < points.length) {
    const anchor = points[i];
    let j = i;
    while (j + 1 < points.length && distanceM(anchor, points[j + 1]) <= TRACK_RULES.stopRadiusM) j++;
    const span = points[j].t - anchor.t;
    if (j > i && span >= TRACK_RULES.stopMinutes * 60_000) {
      const group = points.slice(i, j + 1);
      let engineMs = 0;
      let idleMs = 0;
      for (let k = 1; k < group.length; k++) {
        const [a, b] = [group[k - 1], group[k]];
        if (a.engineOn !== true || b.engineOn !== true) continue;
        const dt = Math.min(b.t - a.t, MAX_COUNTED_GAP);
        engineMs += dt;
        if ((a.kph ?? 0) < 3 && (b.kph ?? 0) < 3) idleMs += dt;
      }
      stops.push({
        lat: group.reduce((s, p) => s + p.lat, 0) / group.length,
        lng: group.reduce((s, p) => s + p.lng, 0) / group.length,
        start: anchor.t,
        end: points[j].t,
        minutes: Math.round(span / 60_000),
        engineMinutes: Math.round(engineMs / 60_000),
        idleMinutes: Math.round(idleMs / 60_000),
      });
      i = j + 1;
    } else {
      i++;
    }
  }
  return stops;
}

/**
 * What the engine did during a stop, by what it did most of the time: "Engine off" (with any idling noted),
 * "Idled 45 min", or "Engine running" (working in place).
 */
export function stopEngineLabel(s: Pick<Stop, "minutes" | "engineMinutes" | "idleMinutes">) {
  if (s.engineMinutes < Math.max(1, s.minutes / 2)) return s.idleMinutes >= 1 ? `Engine off · idled ${formatMinutes(s.idleMinutes)}` : "Engine off";
  if (s.idleMinutes >= 1) return `Idled ${formatMinutes(s.idleMinutes)}`;
  return "Engine running";
}

export const formatMinutes = (m: number) => (m >= 90 ? `${Math.round(m / 6) / 10} h` : `${m} min`);

/** Distance driven, counting only movement within segments (not jumps across gaps). */
export const trackDistanceKm = (segments: TrackPoint[][]) =>
  segments.reduce((sum, seg) => sum + seg.slice(1).reduce((s, p, k) => s + distanceM(seg[k], p), 0), 0) / 1000;

/** The point the machine was at (or last at) at time t: index into points, or -1 before the first. */
export function indexAt(points: { t: number }[], t: number): number {
  let lo = 0;
  let hi = points.length - 1;
  if (!points.length || t < points[0].t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

// ---------- replay timeline ----------

/**
 * Replay time vs. real time. With "skip quiet periods", any stretch longer than `capMs` between points (parked,
 * device asleep) plays as `capMs`, so a 3-day history isn't mostly an empty night. Returns cumulative replay
 * positions for each point (ms); replayToReal/realToReplay convert between the two.
 */
export function replayTimeline(points: { t: number }[], skipQuiet: boolean, capMs = 60_000): number[] {
  const out: number[] = [];
  let pos = 0;
  points.forEach((p, i) => {
    if (i > 0) {
      const gap = p.t - points[i - 1].t;
      pos += skipQuiet ? Math.min(gap, capMs) : gap;
    }
    out.push(pos);
  });
  return out;
}

/** Real time at a replay position (interpolated between points). */
export function replayToReal(points: { t: number }[], timeline: number[], pos: number): number {
  if (!points.length) return 0;
  if (pos <= 0) return points[0].t;
  const last = timeline.length - 1;
  if (pos >= timeline[last]) return points[last].t;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timeline[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  const k = Math.min(lo, last - 1);
  const span = timeline[k + 1] - timeline[k];
  const frac = span > 0 ? (pos - timeline[k]) / span : 0;
  return points[k].t + frac * (points[k + 1].t - points[k].t);
}

// ---------- battery ----------

export type VoltagePoint = { t: number; min: number; max: number; avg: number; n: number; engineOn: boolean };

/** Splits a bucketed voltage series where buckets are missing (the device wasn't reporting), so the line breaks. */
export function voltageRuns(points: VoltagePoint[], bucketMs: number): VoltagePoint[][] {
  const runs: VoltagePoint[][] = [];
  for (const p of points) {
    const run = runs.at(-1);
    if (run && p.t - run.at(-1)!.t <= 2 * bucketMs) run.push(p);
    else runs.push([p]);
  }
  return runs;
}
