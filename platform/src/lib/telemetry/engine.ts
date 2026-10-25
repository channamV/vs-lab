import { num, type SampleFields } from "@/lib/freematics/protocol";

/**
 * Engine-on ("run state") detection from what the stock Telelogger already sends.
 *
 * Signals, best first:
 *  1. RPM from the engine computer — J1939 (heavy equipment, our firmware fork) or OBD-II. Exact.
 *  2. Supply voltage — when the engine runs, the alternator charges the battery:
 *       12 V systems: ~13.8–14.4 V running, ~12.6 V or less off
 *       24 V systems (common on heavy equipment): ~27.5–28.5 V running, ~25 V or less off
 *  3. Vibration — accelerometer magnitude away from 1 g. Weakest signal: a parked machine
 *     can be bumped, and a smooth idle may not register. Used only when nothing else is available.
 */
export const ENGINE_THRESHOLDS = {
  minRpm: 300,
  /** Readings above this are treated as a 24 V system. */
  volts24SystemAbove: 18,
  runningVolts12: 13.2,
  runningVolts24: 26.4,
  /**
   * Supply readings below this mean the device isn't on machine power: USB (3.6–3.7 V seen on a desk) or a
   * bench supply. They give no voltage engine reading and don't count for the low battery warning. A 12 V
   * system the device runs on reads ~10.5 V or more even when flat (and rarely dips under ~9.5 V while
   * cranking); below 8 V it couldn't start the machine anyway.
   */
  machinePowerMinVolts: 8,
  vibrationG: 0.05,
  /** A running session with no data for this long is treated as ended at its last report. */
  staleMinutes: 10,
};

export type EngineSource = "rpm" | "voltage" | "vibration";

export interface EngineReading {
  running: boolean | null; // null = can't tell from this sample
  source: EngineSource | null;
}

export function detectEngine(fields: SampleFields): EngineReading {
  const t = ENGINE_THRESHOLDS;

  const rpm = num(fields, "j1939Rpm") ?? num(fields, "obdRpm");
  if (rpm !== null) return { running: rpm >= t.minRpm, source: "rpm" };

  const centivolts = num(fields, "batteryCentivolts");
  if (centivolts !== null && centivolts / 100 >= t.machinePowerMinVolts) {
    const volts = centivolts / 100;
    const threshold = volts > t.volts24SystemAbove ? t.runningVolts24 : t.runningVolts12;
    return { running: volts >= threshold, source: "voltage" };
  }

  const accel = fields.accel;
  if (Array.isArray(accel) && accel.length === 3) {
    const g = Math.hypot(accel[0], accel[1], accel[2]);
    return { running: Math.abs(g - 1) >= t.vibrationG, source: "vibration" };
  }

  return { running: null, source: null };
}

export interface SessionSpan {
  startedAt: Date;
  endedAt: Date | null;
  lastSeenAt: Date;
}

/** When a session effectively ended: its end, or its last report if it has gone stale, or now. */
export function effectiveEnd(s: SessionSpan, now: number): number {
  if (s.endedAt) return s.endedAt.getTime();
  const staleMs = ENGINE_THRESHOLDS.staleMinutes * 60_000;
  return now - s.lastSeenAt.getTime() > staleMs ? s.lastSeenAt.getTime() : now;
}

// ---------- Time-zone helpers (engine hours are counted per local calendar day) ----------

export function appTimeZone(): string {
  return process.env.APP_TIMEZONE || "America/Toronto";
}

/** The hour of the day (0–23) at `at` in the given time zone. */
export function localHour(at: Date, timeZone: string): number {
  return partsInZone(at.getTime(), timeZone).h;
}

function partsInZone(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(ms);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour"), min: get("minute"), s: get("second") };
}

/** Offset of the zone from UTC at a given instant, in ms. */
function zoneOffset(ms: number, timeZone: string): number {
  const p = partsInZone(ms, timeZone);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.min, p.s);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The UTC instant of local midnight for a calendar date in the zone. */
export function midnightInZone(y: number, m: number, d: number, timeZone: string): number {
  const guess = Date.UTC(y, m - 1, d);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone); // second pass handles DST changes
  return result;
}

/** A wall-clock time in the zone ("2026-10-22T18:30", from a datetime-local field) as a Date; null if malformed. */
export function zonedTime(local: string, timeZone: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local.trim());
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let result = guess - zoneOffset(guess, timeZone);
  result = guess - zoneOffset(result, timeZone);
  return new Date(result);
}

export function localDateKey(ms: number, timeZone: string): string {
  const p = partsInZone(ms, timeZone);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** Local midnight that starts the day `daysAgo` days before the day containing `now`. */
export function startOfLocalDay(now: number, timeZone: string, daysAgo = 0): number {
  const p = partsInZone(now, timeZone);
  // Date.UTC normalises day underflow (e.g. day 0 → last day of previous month).
  const shifted = new Date(Date.UTC(p.y, p.m - 1, p.d - daysAgo));
  return midnightInZone(shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate(), timeZone);
}

export interface DayHours {
  date: string; // YYYY-MM-DD, local
  hours: number;
}

/** Engine hours for each of the last `days` local days (oldest first, today last). */
export function hoursByDay(sessions: SessionSpan[], now: number, days: number, timeZone: string): DayHours[] {
  const result: DayHours[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const dayStart = startOfLocalDay(now, timeZone, i);
    const dayEnd = i === 0 ? now : startOfLocalDay(now, timeZone, i - 1);
    let ms = 0;
    for (const s of sessions) {
      const start = Math.max(s.startedAt.getTime(), dayStart);
      const end = Math.min(effectiveEnd(s, now), dayEnd);
      if (end > start) ms += end - start;
    }
    result.push({ date: localDateKey(dayStart, timeZone), hours: ms / 3_600_000 });
  }
  return result;
}
