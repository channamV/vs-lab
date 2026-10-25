/** Kinds of entry in the safety log (src/lib/safety.ts), with the unit of their peak/limit values. Browser-safe. */
export const SAFETY_KINDS = {
  speeding: "Speeding",
  posted_speeding: "Over posted speed limit",
  restricted_area: "Restricted area entered",
  excessive_idle: "Excessive idling",
  fatigue_daily: "Long day (operator)",
  fatigue_continuous: "No break (operator)",
} as const;
export type SafetyKind = keyof typeof SAFETY_KINDS;

export const SAFETY_UNITS: Record<SafetyKind, string> = {
  speeding: "km/h",
  posted_speeding: "km/h",
  restricted_area: "",
  excessive_idle: "min",
  fatigue_daily: "h",
  fatigue_continuous: "h",
};
