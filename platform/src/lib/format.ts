import type { Tier } from "@/lib/db/schema";

export const TIER_LABELS: Record<Tier, string> = {
  gps: "GPS & Telematics",
  monitor: "Safety & Access Monitoring",
  control: "Safety & Access Control",
};

export function timeAgo(date: Date | null, now = Date.now()): string {
  if (!date) return "never";
  const s = Math.max(0, Math.round((now - date.getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function fmt(value: number | null | undefined, digits = 1, unit = ""): string {
  if (value === null || value === undefined) return "—";
  return `${value.toFixed(digits)}${unit}`;
}

/** 1.5 → "1 h 30 min", 0.25 → "15 min" */
export function formatHours(hours: number): string {
  const totalMin = Math.round(hours * 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Clock time in the platform's time zone, e.g. "9:42 AM" or "Oct 14, 9:42 AM" if not today. */
export function clockTime(date: Date, timeZone: string, now = Date.now()): string {
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(date) ===
    new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "short" }).format(now);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "2-digit",
    ...(sameDay ? {} : { month: "short", day: "numeric" }),
  }).format(date);
}

/** 85 → "85 m", 2300 → "2.3 km" */
export function formatDistance(metres: number | null | undefined): string {
  if (metres === null || metres === undefined) return "—";
  return metres < 1000 ? `${Math.round(metres)} m` : `${(metres / 1000).toFixed(1)} km`;
}
