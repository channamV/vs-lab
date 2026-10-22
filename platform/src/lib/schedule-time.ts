/**
 * Schedules: time windows, plain-English descriptions and conflicts. Browser-safe (the form's live preview uses
 * it) and shared with the scheduler (src/lib/schedules.ts). Ported from the V1-267 prototype
 * (veristart-web-cloud, branch claude/peaceful-knuth-o2mdr9). docs/schedules.md.
 *
 * All times are wall-clock in the schedule's timezone and converted with the zone's own daylight-saving rules,
 * so "every weekday 18:00–06:00" stays 6 PM local all year, and overnight windows end the next morning.
 */
import { MODES, type Mode } from "@/lib/mode-types";

export type ScheduleAction = "machine_mode" | "operator_access";
export type Recurrence = "once" | "weekly" | "override";
export type EndBehavior = "revert" | "set_mode";
export type ConflictRule = "least_restrictive" | "most_restrictive";

/** A schedule as the time logic sees it (the database row has the same fields). */
export type ScheduleSpec = {
  id?: number;
  name: string;
  status: string;
  action: string;
  mode: string | null;
  machineIds: number[];
  operatorIds: number[];
  recurrence: string;
  timezone: string;
  startDate: string | null;
  startTime: string | null;
  endDate: string | null;
  endTime: string | null;
  noEnd: boolean;
  weekdays: number[];
  allDay: boolean;
  effectiveFrom: string | null;
  effectiveUntil: string | null;
  endBehavior: string;
  endMode: string | null;
  remindBeforeExpiry: boolean;
};

export const RECURRENCE_LABEL: Record<Recurrence, string> = { once: "One-time", weekly: "Weekly", override: "Temporary override" };
export const ACTION_LABEL: Record<ScheduleAction, string> = { machine_mode: "Machine Mode", operator_access: "Operator Access" };
export const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Canadian zones offered in the form (any IANA zone stored is still honoured). */
export const TIMEZONES = [
  { value: "America/St_Johns", label: "Newfoundland" },
  { value: "America/Halifax", label: "Atlantic" },
  { value: "America/Toronto", label: "Eastern" },
  { value: "America/Winnipeg", label: "Central" },
  { value: "America/Regina", label: "Saskatchewan" },
  { value: "America/Edmonton", label: "Mountain" },
  { value: "America/Vancouver", label: "Pacific" },
];
export const isTimezone = (tz: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
};

/** Least restrictive first. */
export const RESTRICTIVENESS: Record<Mode, number> = { unlocked: 0, access_controlled: 1, locked: 2 };

const MINUTE = 60_000;
const HORIZON_DAYS = 35;
const modeLabel = (m: string | null | undefined) => (m && m in MODES ? MODES[m as Mode].label : "—");

// ---------- time ----------

const tzOffsetMs = (utcMs: number, timezone: string) => {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const m = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return Date.UTC(+m.year, +m.month - 1, +m.day, +m.hour % 24, +m.minute, +m.second) - utcMs;
};

/** A wall-clock date ("2026-10-22") and time ("18:00") in `timezone` → UTC milliseconds. */
export function zonedToUtc(date: string, time: string, timezone: string): number {
  const [y, mo, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - tzOffsetMs(guess, timezone);
  return guess - tzOffsetMs(first, timezone);
}

export const todayIn = (timezone: string, now = Date.now()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now));
export const timeIn = (timezone: string, now = Date.now()) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(now));
export const addDays = (date: string, days: number) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
};
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

export const fmtTime = (time?: string | null) => {
  if (!time) return "";
  const [h, m] = time.split(":").map(Number);
  if (h === 24) return "midnight";
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
};
export const fmtDate = (date?: string | null) =>
  date ? new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) : "";
export const fmtInstant = (
  ms: number,
  timezone: string,
  opts: Intl.DateTimeFormatOptions = { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" },
) => new Date(ms).toLocaleString("en-US", { timeZone: timezone, ...opts });

export const tzOffsetLabel = (timezone: string, at = Date.now()) => {
  const minutes = Math.round(tzOffsetMs(at, timezone) / MINUTE);
  const abs = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
};
/** "EDT", or the UTC offset where there's no abbreviation (e.g. Newfoundland). */
export const tzShort = (timezone: string, at = Date.now()) => {
  const short = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
    .formatToParts(new Date(at))
    .find((p) => p.type === "timeZoneName")?.value;
  return !short || short.startsWith("GMT") ? tzOffsetLabel(timezone, at) : short;
};
export const tzName = (timezone: string) => TIMEZONES.find((t) => t.value === timezone)?.label ?? timezone;

export const fmtDuration = (ms: number) => {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest ? `${hours} h ${rest} min` : `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.round(hours / 24)} days`;
};

// ---------- occurrences ----------

/** A window: start and end (null = no end) in UTC ms. */
export type Occurrence = { start: number; end: number | null };

/** The schedule's windows that haven't ended by `from`, up to `days` ahead. */
export function occurrences(s: ScheduleSpec, from = Date.now(), days = HORIZON_DAYS): Occurrence[] {
  const tz = s.timezone;
  const until = from + days * 86_400_000;
  if (s.recurrence !== "weekly") {
    if (!s.startDate || !s.startTime) return [];
    const start = zonedToUtc(s.startDate, s.startTime, tz);
    const end = s.noEnd || !s.endDate || !s.endTime ? null : zonedToUtc(s.endDate, s.endTime, tz);
    if (end !== null && end <= from) return [];
    return [{ start, end }];
  }
  if (!s.weekdays.length) return [];
  const startTime = s.allDay ? "00:00" : s.startTime;
  const endTime = s.allDay ? "24:00" : s.endTime;
  if (!startTime || !endTime || startTime === endTime) return [];
  const overnight = endTime <= startTime;
  const result: Occurrence[] = [];
  // Start a day back so an overnight window that began yesterday is included.
  let date = addDays(todayIn(tz, from), -1);
  for (let i = 0; i <= days + 1; i++, date = addDays(date, 1)) {
    if (s.effectiveFrom && date < s.effectiveFrom) continue;
    if (s.effectiveUntil && date > s.effectiveUntil) break;
    if (!s.weekdays.includes(weekdayOf(date))) continue;
    const start = zonedToUtc(date, startTime, tz);
    const end = endTime === "24:00" ? zonedToUtc(addDays(date, 1), "00:00", tz) : zonedToUtc(overnight ? addDays(date, 1) : date, endTime, tz);
    if (start > until) break;
    if (end <= from) continue;
    // Back-to-back windows (all-day Sat + Sun) are one.
    const last = result.at(-1);
    if (last && last.end === start) last.end = end;
    else result.push({ start, end });
  }
  return result;
}

/** The window in effect at `now`, if any. */
export const currentWindow = (s: ScheduleSpec, now = Date.now()) =>
  occurrences(s, now, 2).find((o) => o.start <= now && (o.end === null || o.end > now)) ?? null;

export type ScheduleStateLabel = "In effect" | "Scheduled" | "Completed" | "Paused" | "No upcoming runs";
export function scheduleState(s: ScheduleSpec, now = Date.now()): { label: ScheduleStateLabel; current?: Occurrence; next?: Occurrence } {
  const list = occurrences(s, now);
  const current = list.find((o) => o.start <= now && (o.end === null || o.end > now));
  const next = list.find((o) => o.start > now);
  if (s.status === "paused") return { label: "Paused", current, next };
  if (current) return { label: "In effect", current, next };
  if (next) return { label: "Scheduled", next };
  return { label: s.recurrence === "weekly" ? "No upcoming runs" : "Completed" };
}

// ---------- validation ----------

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Problems that stop a schedule being saved, in plain words. Empty = OK. */
export function validateSchedule(s: ScheduleSpec, now = Date.now()): string[] {
  const issues: string[] = [];
  if (!s.name.trim()) issues.push("Give the schedule a name.");
  if (!isTimezone(s.timezone)) issues.push("Choose a timezone.");
  if (s.action === "machine_mode" && !(s.mode && s.mode in MODES)) issues.push("Choose the machine mode to apply.");
  if (s.action === "operator_access") {
    if (!s.machineIds.length) issues.push("Select at least one machine.");
    if (!s.operatorIds.length) issues.push("Select at least one operator.");
  }
  if (s.recurrence === "weekly") {
    if (!s.weekdays.length) issues.push("Select at least one day of the week.");
    if (!s.allDay && (!s.startTime || !s.endTime || !TIME.test(s.startTime) || !TIME.test(s.endTime))) issues.push("Set a start and end time, or choose All day.");
    else if (!s.allDay && s.startTime === s.endTime) issues.push("Start and end times can't be the same. Use All day for a 24-hour window.");
    if ((s.effectiveFrom && !DATE.test(s.effectiveFrom)) || (s.effectiveUntil && !DATE.test(s.effectiveUntil))) issues.push("Check the dates.");
    else if (s.effectiveFrom && s.effectiveUntil && s.effectiveUntil < s.effectiveFrom) issues.push("The end date must be after the start date.");
  } else if (s.recurrence === "once" || s.recurrence === "override") {
    if (!s.startDate || !s.startTime || !DATE.test(s.startDate) || !TIME.test(s.startTime)) issues.push("Set a start date and time.");
    else if (!s.noEnd) {
      if (!s.endDate || !s.endTime || !DATE.test(s.endDate) || !TIME.test(s.endTime)) issues.push("Set an end date and time.");
      else {
        const start = zonedToUtc(s.startDate, s.startTime, s.timezone);
        const end = zonedToUtc(s.endDate, s.endTime, s.timezone);
        if (end <= start) issues.push("The end must be after the start.");
        else if (end <= now) issues.push("The end time is already in the past.");
      }
    }
    if (s.noEnd && (s.action !== "machine_mode" || s.recurrence !== "once")) issues.push("Only one-time Machine Mode schedules can have no end.");
  } else issues.push("Choose one-time, weekly or temporary override.");
  if (s.action === "machine_mode" && s.endBehavior === "set_mode") {
    if (!(s.endMode && s.endMode in MODES)) issues.push("Choose the mode to switch to when the window ends.");
    else if (s.endMode === s.mode) issues.push("The end mode is the same as the scheduled mode: choose a different mode or “Return to previous mode”.");
  }
  return issues;
}

// ---------- descriptions ----------

export type Names = { machines: Map<number, string>; operators: Map<number, string>; allMachines: number[] };

const listNames = (names: string[], max = 3) => {
  if (names.length <= max) return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
};
export const describeDays = (weekdays: number[]) => {
  const sorted = [...weekdays].sort();
  if (sorted.length === 7) return "every day";
  if (sorted.join() === "1,2,3,4,5") return "every weekday (Mon–Fri)";
  if (sorted.join() === "0,6") return "every Saturday and Sunday";
  return `every ${listNames(sorted.map((d) => DAY_NAMES[d]), 7)}`;
};
const machineSubject = (s: ScheduleSpec, n: Names, max = 4) =>
  s.machineIds.length ? listNames(s.machineIds.map((id) => n.machines.get(id) ?? `#${id}`), max) : s.action === "machine_mode" ? "all machines" : "no machines selected";
const operatorSubject = (s: ScheduleSpec, n: Names, max = 4) =>
  s.operatorIds.length ? listNames(s.operatorIds.map((id) => n.operators.get(id) ?? `#${id}`), max) : "No operators selected";
const effectiveRange = (s: ScheduleSpec) => {
  if (s.effectiveFrom && s.effectiveUntil) return `from ${fmtDate(s.effectiveFrom)} through ${fmtDate(s.effectiveUntil)}`;
  if (s.effectiveFrom && s.effectiveFrom > todayIn(s.timezone)) return `starting ${fmtDate(s.effectiveFrom)}, with no end date`;
  if (s.effectiveUntil) return `until ${fmtDate(s.effectiveUntil)}`;
  return "with no end date";
};
const windowText = (s: ScheduleSpec) => {
  if (s.allDay) return "all day";
  const overnight = s.endTime && s.startTime && s.endTime <= s.startTime;
  return `from ${fmtTime(s.startTime)} to ${fmtTime(s.endTime)}${overnight ? " the next morning" : ""}`;
};
const endText = (s: ScheduleSpec, one: boolean) => {
  const p = one ? "it" : "they";
  if (s.endBehavior === "set_mode" && s.endMode) return `${p} will be set to ${modeLabel(s.endMode)}`;
  if (s.recurrence === "override") {
    return `${p} ${one ? "returns to its" : "return to their"} normal state: whatever ${one ? "its" : "their"} regular schedules call for at that time, or the mode ${one ? "it was" : "they were"} in before the override`;
  }
  return `${p} ${one ? "returns to the mode it was" : "return to the mode they were"} in before (unless another schedule applies)`;
};

/** The plain-English Schedule Preview. */
export function describeSchedule(s: ScheduleSpec, n: Names, now = Date.now()): string[] {
  const machines = machineSubject(s, n, 6);
  const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
  const one = s.machineIds.length === 1;
  const lines: string[] = [];
  const startAt = s.startDate ? `${fmtDate(s.startDate)} at ${fmtTime(s.startTime)}` : "";
  const endAt = s.endDate ? `${fmtDate(s.endDate)} at ${fmtTime(s.endTime)}` : "";
  const duration =
    s.startDate && s.endDate && s.startTime && s.endTime
      ? fmtDuration(zonedToUtc(s.endDate, s.endTime, s.timezone) - zonedToUtc(s.startDate, s.startTime, s.timezone))
      : "";
  const startsNow = s.startDate && s.startTime && zonedToUtc(s.startDate, s.startTime, s.timezone) <= now + MINUTE;

  if (s.action === "machine_mode") {
    const mode = modeLabel(s.mode);
    if (s.recurrence === "once") {
      lines.push(`On ${startAt}, ${machines} will be set to ${mode}.`);
      lines.push(
        s.noEnd ? `${one ? "It" : "They"} will stay ${mode} until someone changes ${one ? "it" : "them"} by hand.` : `On ${endAt} (${duration} later), ${endText(s, one)}.`,
      );
    } else if (s.recurrence === "weekly") {
      lines.push(`${cap(describeDays(s.weekdays))} ${windowText(s)}, ${machines} will be set to ${mode}.`);
      lines.push(s.allDay ? `At the end of each scheduled day, ${endText(s, one)}.` : `At ${fmtTime(s.endTime)}, ${endText(s, one)}.`);
      lines.push(`This repeats ${effectiveRange(s)}.`);
    } else {
      lines.push(
        `${startsNow ? `Starting now (${startAt})` : `Starting ${startAt}`}, ${machines} will be held at ${mode} until ${endAt} (${duration}), overriding any other schedules for ${one ? "that machine" : "those machines"}.`,
      );
      lines.push(`When the override expires, ${endText(s, one)}.`);
    }
  } else {
    const ops = operatorSubject(s, n, 6);
    if (s.recurrence === "once") {
      lines.push(`${ops} will be able to start ${machines} from ${startAt} until ${endAt} (${duration}).`);
      lines.push("When the window ends, this temporary access is removed.");
    } else if (s.recurrence === "weekly") {
      lines.push(`${ops} will be able to start ${machines} ${describeDays(s.weekdays)} ${windowText(s)}, ${effectiveRange(s)}.`);
      lines.push("Outside these hours, access given by this schedule is removed.");
    } else {
      lines.push(`${startsNow ? `Starting now (${startAt})` : `Starting ${startAt}`}, ${ops} will be able to start ${machines} until ${endAt} (${duration}).`);
      lines.push("When the override expires, this temporary access ends automatically.");
    }
    lines.push("Permanent operator approvals aren't changed. Access only matters while a machine is Access-Controlled.");
  }
  if (s.remindBeforeExpiry && s.recurrence === "override") lines.push("You'll get an email 15 minutes before the override expires.");
  return lines;
}

/** One line for the Schedules list. */
export function summarizeSchedule(s: ScheduleSpec, n: Names) {
  const machines = machineSubject(s, n, 2);
  const target =
    s.action === "machine_mode" ? `${machines.charAt(0).toUpperCase() + machines.slice(1)} → ${modeLabel(s.mode)}` : `${operatorSubject(s, n, 2)} → ${machines}`;
  if (s.recurrence === "weekly") {
    const sorted = [...s.weekdays].sort();
    const days = sorted.length === 7 ? "Daily" : sorted.join() === "1,2,3,4,5" ? "Mon–Fri" : sorted.join() === "0,6" ? "Sat–Sun" : sorted.map((d) => DAYS[d]).join(", ");
    return `${target} · ${days} ${s.allDay ? "all day" : `${fmtTime(s.startTime)}–${fmtTime(s.endTime)}`}`;
  }
  return `${target} · ${fmtDate(s.startDate)} ${fmtTime(s.startTime)} → ${s.noEnd ? "no end" : `${fmtDate(s.endDate)} ${fmtTime(s.endTime)}`}`;
}

// ---------- conflicts ----------

export type ConflictSeverity = "conflict" | "warning" | "overlap" | "info";
export type Conflict = { otherId: number; otherName: string; severity: ConflictSeverity; message: string; resolution?: string; window: Occurrence };

const machineSet = (s: ScheduleSpec, n: Names) => (s.machineIds.length ? s.machineIds : n.allMachines);
const firstOverlap = (a: Occurrence[], b: Occurrence[]): Occurrence | null => {
  for (const x of a) {
    for (const y of b) {
      const xEnd = x.end ?? Infinity;
      const yEnd = y.end ?? Infinity;
      if (x.start < yEnd && y.start < xEnd) {
        const end = Math.min(xEnd, yEnd);
        return { start: Math.max(x.start, y.start), end: end === Infinity ? null : end };
      }
    }
  }
  return null;
};

/** Which of two disagreeing modes wins under the company's rule. */
export const winningMode = (a: Mode, b: Mode, rule: ConflictRule): Mode =>
  rule === "most_restrictive" ? (RESTRICTIVENESS[a] >= RESTRICTIVENESS[b] ? a : b) : RESTRICTIVENESS[a] <= RESTRICTIVENESS[b] ? a : b;

/** How a draft schedule interacts with the other active schedules (for the preview and the list). */
export function findConflicts(draft: ScheduleSpec, others: ScheduleSpec[], n: Names, rule: ConflictRule, now = Date.now()): Conflict[] {
  const draftMachines = machineSet(draft, n);
  const draftOcc = occurrences(draft, now);
  const result: Conflict[] = [];
  const ruleText = rule === "most_restrictive" ? "the most restrictive mode applies" : "the least restrictive mode applies so work isn't blocked";
  for (const other of others) {
    if (other.id === draft.id || other.status === "paused") continue;
    const shared = machineSet(other, n).filter((id) => draftMachines.includes(id));
    if (!shared.length) continue;
    const window = firstOverlap(draftOcc, occurrences(other, now));
    if (!window) continue;
    const names = listNames(shared.map((id) => n.machines.get(id) ?? `#${id}`));
    const them = shared.length > 1 ? "them" : "it";
    const base = { otherId: other.id!, otherName: other.name, window };

    if (draft.action === "machine_mode" && other.action === "machine_mode" && draft.mode && other.mode) {
      const draftOverride = draft.recurrence === "override";
      const otherOverride = other.recurrence === "override";
      if (draft.mode === other.mode) {
        result.push({ ...base, severity: "overlap", message: `Both schedules set ${names} to ${modeLabel(draft.mode)} at the same time. Redundant but harmless.` });
      } else if (draftOverride !== otherOverride) {
        result.push({
          ...base,
          severity: "info",
          message: `${draftOverride ? "This override" : `“${other.name}”`} takes priority for ${names} while it's active. The regular schedule resumes when the override ends.`,
        });
      } else {
        const winner = winningMode(draft.mode as Mode, other.mode as Mode, rule);
        result.push({
          ...base,
          severity: "conflict",
          message: `This schedule sets ${names} to ${modeLabel(draft.mode)}, but “${other.name}” sets ${them} to ${modeLabel(other.mode)} at the same time.`,
          resolution: `If both stay active, ${ruleText}: ${modeLabel(winner)}.`,
        });
      }
      continue;
    }
    const access = draft.action === "operator_access" ? draft : other.action === "operator_access" ? other : null;
    const mode = draft.action === "machine_mode" ? draft : other.action === "machine_mode" ? other : null;
    if (access && mode && mode.mode) {
      const accessIsDraft = access === draft;
      if (mode.mode === "locked") {
        result.push({
          ...base,
          severity: "conflict",
          message: accessIsDraft
            ? `“${other.name}” locks ${names} during part of this window, but this schedule gives operators access to ${them}.`
            : `This schedule locks ${names}, but “${other.name}” gives operators access to ${them} at the same time.`,
          resolution: `If both stay active, scheduled access wins so work isn't blocked: ${names} will be Access-Controlled during the overlap.`,
        });
      } else if (mode.mode === "unlocked") {
        result.push({
          ...base,
          severity: "warning",
          message: accessIsDraft
            ? `“${other.name}” unlocks ${names} during part of this window, so anyone can start ${them}: access isn't limited to these operators.`
            : `While Unlocked, ${names} can be started by anyone, so the operator limits in “${other.name}” don't apply.`,
        });
      }
      continue;
    }
    if (draft.action === "operator_access" && other.action === "operator_access") {
      const ops = draft.operatorIds.filter((id) => other.operatorIds.includes(id));
      if (!ops.length) continue;
      result.push({
        ...base,
        severity: "overlap",
        message: `${listNames(ops.map((id) => n.operators.get(id) ?? `#${id}`))} already ${ops.length > 1 ? "have" : "has"} access to ${names} from “${other.name}” during this window.`,
      });
    }
  }
  const order: ConflictSeverity[] = ["conflict", "warning", "overlap", "info"];
  return result.sort((a, b) => order.indexOf(a.severity) - order.indexOf(b.severity));
}

// ---------- what a machine should be ----------

/**
 * The mode the schedules call for on one machine at `now`, or null when no schedule window applies. Overrides beat
 * regular schedules; among equals the company's conflict rule decides; scheduled operator access turns a scheduled
 * Locked into Access-Controlled. `ignoreStartedBefore`: a manager changed the mode by hand at that time, so windows
 * already running then are skipped until the next one.
 */
export function resolveMachine(
  machineId: number,
  active: ScheduleSpec[],
  allMachineIds: number[],
  rule: ConflictRule,
  now: number,
  ignoreStartedBefore: number | null = null,
): { mode: Mode; scheduleId: number } | null {
  const applies = (s: ScheduleSpec) => (s.machineIds.length ? s.machineIds : allMachineIds).includes(machineId);
  const live = active
    .filter((s) => s.status === "active" && applies(s))
    .map((s) => ({ s, w: currentWindow(s, now) }))
    .filter((x) => x.w && (ignoreStartedBefore === null || x.w.start > ignoreStartedBefore));
  const pick = (list: typeof live) =>
    list.reduce<{ mode: Mode; scheduleId: number } | null>((best, { s }) => {
      const mode = s.mode as Mode;
      if (!best) return { mode, scheduleId: s.id! };
      const win = winningMode(best.mode, mode, rule);
      return win === best.mode ? best : { mode, scheduleId: s.id! };
    }, null);
  const modes = live.filter((x) => x.s.action === "machine_mode" && x.s.mode && x.s.mode in MODES);
  const overrides = modes.filter((x) => x.s.recurrence === "override");
  let result = pick(overrides.length ? overrides : modes);
  // Scheduled operator access wins over a scheduled Locked (the operators need to be able to start it).
  const access = live.find((x) => x.s.action === "operator_access");
  if (result?.mode === "locked" && access) result = { mode: "access_controlled", scheduleId: access.s.id! };
  return result;
}

/** Operators who have scheduled access to this machine right now. */
export function scheduledOperators(machineId: number, active: ScheduleSpec[], now: number): number[] {
  const ids = new Set<number>();
  for (const s of active) {
    if (s.status !== "active" || s.action !== "operator_access" || !s.machineIds.includes(machineId)) continue;
    if (currentWindow(s, now)) s.operatorIds.forEach((id) => ids.add(id));
  }
  return [...ids];
}
