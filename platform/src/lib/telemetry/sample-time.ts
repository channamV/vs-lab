import { num, type SampleFields } from "@/lib/freematics/protocol";

/**
 * When each sample was taken (docs/store-and-forward.md, step 1). Telelogger keeps readings it couldn't send and
 * sends them later, newest first, so arrival time puts late readings in the wrong place (a parked machine's map
 * fanned out to its earlier route). Each GPS reading carries the GPS time of day (UTC, HHMMSScc; PID 0x10) and, from
 * our firmware (2026-10-25), the GPS date (DDMMYY; PID 0x11). Every sample carries the device's uptime in ms (PID 0):
 *  - GPS date + time → that moment (up to maxDatedBacklogMs old, e.g. a replay from the memory card);
 *  - GPS time only (stock firmware) → today's date at that time, or yesterday's if that would be in the future
 *    (backlogs are minutes, not days; a GPS time over maxBacklogMs old is treated as a bad clock);
 *  - no GPS time → the uptime difference from a sample in the same upload that has one;
 *  - neither → the uptime difference from the newest sample, taken as "now"; no uptime → arrival time.
 * Never later than arrival.
 */

export const SAMPLE_TIME_RULES = {
  /** A GPS time this far ahead of arrival is taken as yesterday's (device clock and fix age allow a little). */
  futureSlackMs: 10 * 60_000,
  /** An upload whose newest reading is older than this is a late backlog: stored for history, not used as "now". */
  lateMs: 2 * 60_000,
  /**
   * A GPS time older than this is distrusted (uptime is used instead): the device's memory holds about 85 minutes
   * today, so anything much older is more likely a bad clock than a backlog. Raise it with store-and-forward step 2/3.
   */
  maxBacklogMs: 6 * 3_600_000,
  /** With the GPS date sent, a reading can be this old (kept on the device while out of coverage) and still be used. */
  maxDatedBacklogMs: 30 * 86_400_000,
};

const DAY = 86_400_000;

/**
 * A GPS time of day (HHMMSScc, UTC) as a moment: on the GPS date (DDMMYY) when given and plausible, else near `now`.
 * Null if it isn't a valid time.
 */
export function gpsTimeToDate(value: number | null, now: Date, date: number | null = null): number | null {
  if (value === null || !Number.isInteger(value) || value < 0) return null;
  const hh = Math.floor(value / 1_000_000);
  const mm = Math.floor(value / 10_000) % 100;
  const ss = Math.floor(value / 100) % 100;
  const cc = value % 100;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  const timeOfDay = ((hh * 60 + mm) * 60 + ss) * 1000 + cc * 10;
  if (date !== null && Number.isInteger(date) && date > 0) {
    const day = Math.floor(date / 10_000);
    const month = Math.floor(date / 100) % 100;
    const year = 2000 + (date % 100);
    const midnight = Date.UTC(year, month - 1, day);
    const t = midnight + timeOfDay;
    const valid = day >= 1 && day <= 31 && month >= 1 && month <= 12 && new Date(midnight).getUTCDate() === day;
    if (valid && t <= now.getTime() + SAMPLE_TIME_RULES.futureSlackMs && t >= now.getTime() - SAMPLE_TIME_RULES.maxDatedBacklogMs) return t;
    // An implausible date (e.g. the GPS before its first fix): fall back to the time of day alone.
  }
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let t = midnight + timeOfDay;
  if (t > now.getTime() + SAMPLE_TIME_RULES.futureSlackMs) t -= DAY;
  return t < now.getTime() - SAMPLE_TIME_RULES.maxBacklogMs ? null : t;
}

/** The time each sample was taken, in the same order as `samples`. */
export function sampleTimes(samples: SampleFields[], now: Date): Date[] {
  const gps = samples.map((f) => gpsTimeToDate(num(f, "gpsTime"), now, num(f, "gpsDate")));
  const uptime = samples.map((f) => num(f, "deviceMs"));
  // Uptime → clock offset: from a GPS reading in this upload (latest one), else assume the newest sample is now.
  let offset: number | null = null;
  let anchorUptime = -Infinity;
  for (let i = 0; i < samples.length; i++) {
    if (gps[i] !== null && uptime[i] !== null && uptime[i]! > anchorUptime) {
      anchorUptime = uptime[i]!;
      offset = gps[i]! - uptime[i]!;
    }
  }
  const known = uptime.filter((u): u is number => u !== null);
  if (offset === null && known.length) offset = now.getTime() - Math.max(...known);
  return samples.map((_, i) => {
    const t = gps[i] ?? (uptime[i] !== null && offset !== null ? uptime[i]! + offset : now.getTime());
    return new Date(Math.min(t, now.getTime()));
  });
}
