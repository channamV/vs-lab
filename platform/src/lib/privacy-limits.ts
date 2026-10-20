/** Shared with the Settings form (browser code), so nothing server-only here. See src/lib/privacy.ts. */

/** Retention settings: allowed range in days and what each one covers (shown on the Settings page). */
export const RETENTION_LIMITS = {
  retainPhoneLocationDays: { min: 1, max: 3650, label: "Operators' phone location at check-in" },
  retainPhotoDays: { min: 30, max: 3650, label: "Checklist photos" },
  retainTelemetryDays: { min: 30, max: 3650, label: "GPS track, device data and connectivity incidents" },
  retainCheckinDays: { min: 90, max: 3650, label: "Check-ins, checklist answers, alerts and resolved defects" },
  retainNotificationDays: { min: 30, max: 3650, label: "Notification history (who was told what)" },
} as const;
export type RetentionKey = keyof typeof RETENTION_LIMITS;
export const RETENTION_KEYS = Object.keys(RETENTION_LIMITS) as RetentionKey[];
