/**
 * Maintenance labels, priorities and the "is a service due?" rules (browser-safe; src/lib/maintenance.ts does the
 * database work; docs/maintenance.md). Modelled on Veristart Insights' maintenance module.
 */

export const MAINTENANCE_RULES = {
  /** A service is "due soon" in the last share of its interval (10%: 50 h of a 500 h service, 3 days of 30). */
  dueSoonShare: 0.1,
  /** A paired machine that hasn't reported in this long gets a "Device offline" item (closed when it reports). */
  offlineHours: 72,
  /** Attachments: photos, PDFs and videos staff add to an item. */
  attachmentMaxBytes: 3_800_000,
  attachmentTypes: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  /** Hour meter / odometer readings above this are typos. */
  maxReading: 2_000_000,
};

export const PRIORITIES = {
  lockout: { label: "Locked out", rank: 6, style: "bg-red-600 text-white", dot: "#dc2626" },
  major: { label: "Major", rank: 5, style: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300", dot: "#ef4444" },
  overdue_pm: { label: "Service due", rank: 4, style: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300", dot: "#0284c7" },
  minor: { label: "Minor", rank: 3, style: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200", dot: "#d97706" },
  connectivity: { label: "Device offline", rank: 2, style: "bg-slate-200 text-slate-800 dark:bg-slate-700 dark:text-slate-200", dot: "#64748b" },
  low: { label: "Low", rank: 1, style: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400", dot: "#94a3b8" },
} as const;
export type Priority = keyof typeof PRIORITIES;
/** Priorities staff can choose (the others come from checklists, schedules and devices, but can be changed too). */
export const PRIORITY_CHOICES: Priority[] = ["lockout", "major", "overdue_pm", "minor", "connectivity", "low"];

export const STATUSES = {
  new: { label: "New", style: "border-t-sky-500" },
  in_progress: { label: "In progress", style: "border-t-amber-500" },
  awaiting_parts: { label: "Awaiting parts", style: "border-t-violet-500" },
  resolved: { label: "Resolved", style: "border-t-emerald-500" },
} as const;
export type Status = keyof typeof STATUSES;
export const OPEN_STATUSES: Status[] = ["new", "in_progress", "awaiting_parts"];

export const SOURCES = {
  checklist: "Checklist",
  schedule: "Service schedule",
  connectivity: "Device",
  manual: "Added by staff",
} as const;
export type Source = keyof typeof SOURCES;

export const SECTIONS = {
  complaint: { label: "Complaint", help: "What was reported" },
  cause: { label: "Cause", help: "What was found when diagnosing it" },
  correction: { label: "Correction", help: "The work done to fix it" },
} as const;
export type Section = keyof typeof SECTIONS;

export const isPriority = (v: string): v is Priority => v in PRIORITIES;
export const isStatus = (v: string): v is Status => v in STATUSES;
export const priorityRank = (p: string) => PRIORITIES[p as Priority]?.rank ?? 0;
/** The most urgent of some priorities. */
export const topPriority = (ps: string[]): Priority | null =>
  ps.length ? (ps.reduce((a, b) => (priorityRank(b) > priorityRank(a) ? b : a)) as Priority) : null;
/** Most urgent first, then oldest first. */
export const byUrgency = <T extends { priority: string; firstReportedAt: Date }>(a: T, b: T) =>
  priorityRank(b.priority) - priorityRank(a.priority) || a.firstReportedAt.getTime() - b.firstReportedAt.getTime();

/** What's still missing before an item can be resolved: all three C's (pure). */
export function missingForResolve(i: { complaint: string | null; cause: string | null; correction: string | null }): string[] {
  return (["complaint", "cause", "correction"] as const).filter((k) => !i[k]?.trim()).map((k) => SECTIONS[k].label);
}

// ---------- Service schedules ----------

export type Interval = { everyDays: number | null; everyHours: number | null; everyKm: number | null };
export type NextDue = { nextDueOn: string | null; nextDueHours: number | null; nextDueKm: number | null };
export type Readings = { hours: number | null; km: number | null };

export type DuePart = { kind: "days" | "hours" | "km"; state: "ok" | "soon" | "due"; /** Left until due (negative = past it). */ left: number };
export type DueState = { state: "ok" | "soon" | "due" | "unknown"; parts: DuePart[] };

/** Whole days from one YYYY-MM-DD to another (pure). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** A YYYY-MM-DD date plus days (pure). */
export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Where a schedule stands (pure): due once any of its limits is reached (whichever first), due soon in the last
 * share of any interval. "unknown" = it counts hours or km and the machine has no reading yet.
 */
export function dueState(s: Interval & NextDue, today: string, now: Readings): DueState {
  const parts: DuePart[] = [];
  const part = (kind: DuePart["kind"], left: number, every: number) =>
    parts.push({ kind, left, state: left <= 0 ? "due" : left <= Math.max(every * MAINTENANCE_RULES.dueSoonShare, kind === "days" ? 1 : 0) ? "soon" : "ok" });
  if (s.everyDays && s.nextDueOn) part("days", daysBetween(today, s.nextDueOn), s.everyDays);
  if (s.everyHours && s.nextDueHours !== null && now.hours !== null) part("hours", s.nextDueHours - now.hours, s.everyHours);
  if (s.everyKm && s.nextDueKm !== null && now.km !== null) part("km", s.nextDueKm - now.km, s.everyKm);
  if (!parts.length) return { state: "unknown", parts };
  const state = parts.some((p) => p.state === "due") ? "due" : parts.some((p) => p.state === "soon") ? "soon" : "ok";
  return { state, parts };
}

/**
 * The next due point from a starting point (pure): when the schedule starts (the last service, or now) or when a
 * service is done. Each interval counts from its own reading; a missing reading leaves that limit unset.
 */
export function nextDueFrom(s: Interval, from: { on: string; hours: number | null; km: number | null }): NextDue {
  return {
    nextDueOn: s.everyDays ? addDays(from.on, s.everyDays) : null,
    nextDueHours: s.everyHours && from.hours !== null ? Math.round((from.hours + s.everyHours) * 10) / 10 : null,
    nextDueKm: s.everyKm && from.km !== null ? Math.round(from.km + s.everyKm) : null,
  };
}

const num = (n: number) => n.toLocaleString("en-CA", { maximumFractionDigits: 1 });

/** "Every 250 h or 6 months" style wording for an interval (pure). */
export function describeInterval(s: Interval): string {
  const parts: string[] = [];
  if (s.everyHours) parts.push(`${num(s.everyHours)} h`);
  if (s.everyKm) parts.push(`${num(s.everyKm)} km`);
  if (s.everyDays) parts.push(s.everyDays % 365 === 0 ? `${s.everyDays / 365} yr` : s.everyDays % 30 === 0 ? `${s.everyDays / 30} mo` : `${s.everyDays} days`);
  return parts.length ? `Every ${parts.join(" or ")}` : "No interval";
}

/** "in 40 h", "12 days overdue" for one limit (pure). */
export function describeDuePart(p: DuePart): string {
  const unit = p.kind === "days" ? "days" : p.kind === "hours" ? "h" : "km";
  const amount = `${num(Math.abs(p.left))} ${unit === "days" && Math.abs(p.left) === 1 ? "day" : unit}`;
  if (p.left < 0) return `${amount} overdue`;
  if (p.left === 0) return p.kind === "days" ? "due today" : "due now";
  return `in ${amount}`;
}
