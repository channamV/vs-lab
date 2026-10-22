import type { CertificationType, TrainingRecord } from "@/lib/db/schema";

/** Training dates and status: pure, browser-safe (the record form uses defaultExpiry). See src/lib/training.ts. */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The expiry date from the issue date and the type's validity. */
export function defaultExpiry(issuedOn: string, validityMonths: number | null): string | null {
  if (!DATE.test(issuedOn) || validityMonths === null) return null;
  const [y, m, d] = issuedOn.split("-").map(Number);
  const months = y * 12 + (m - 1) + validityMonths;
  const ny = Math.floor(months / 12);
  const nm = (months % 12) + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return `${ny}-${String(nm).padStart(2, "0")}-${String(Math.min(d, lastDay)).padStart(2, "0")}`;
}

export type RecordStatus = "valid" | "expiring" | "grace" | "expired";
export const STATUS_LABELS: Record<RecordStatus, string> = { valid: "Valid", expiring: "Expiring soon", grace: "Expired (grace period)", expired: "Expired" };

/** Badge colours for each status. */
export const STATUS_STYLE: Record<RecordStatus, string> = {
  valid: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  expiring: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  grace: "bg-orange-100 text-orange-800 dark:bg-orange-900/50 dark:text-orange-300",
  expired: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};
export const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Where a record stands on `today` (YYYY-MM-DD, company timezone). Counts = still gives / satisfies access. */
export function recordStatus(r: Pick<TrainingRecord, "expiresOn">, type: Pick<CertificationType, "graceDays" | "reminderDays">, today: string) {
  if (!r.expiresOn) return { status: "valid" as RecordStatus, daysLeft: null as number | null, counts: true };
  const daysLeft = daysBetween(today, r.expiresOn);
  if (daysLeft >= 0) {
    const soon = daysLeft <= Math.max(0, ...type.reminderDays, 30);
    return { status: (soon ? "expiring" : "valid") as RecordStatus, daysLeft, counts: true };
  }
  const inGrace = -daysLeft <= type.graceDays;
  return { status: (inGrace ? "grace" : "expired") as RecordStatus, daysLeft, counts: inGrace };
}

