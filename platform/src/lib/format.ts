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
