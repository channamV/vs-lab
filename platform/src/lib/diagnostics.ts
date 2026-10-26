import { and, desc, eq, lt, notInArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceDiagnostics, devices } from "@/lib/db/schema";
import { restartReason } from "@/lib/restart-reasons";

/**
 * Restart reports from our firmware (docs/device-diagnostics.md): after a restart the device posts its last log lines
 * (kept on its memory card) to /hub/api/diag/<DEVID>, so staff can see what happened without fetching the card.
 * Body: an optional first line `BOOT=<n>;RST=<reason>`, then one log line per line.
 */

export const DIAGNOSTIC_RULES = {
  maxBytes: 16_000,
  maxLines: 200,
  maxLineChars: 300,
  keepPerDevice: 30,
  /** Deleted by the nightly privacy clean-up after this long (log lines can include positions). */
  keepDays: 90,
};

export class DiagnosticsError extends Error {}

/** Splits a report into its header (start-up counter, restart reason) and log lines (pure). */
export function parseDiagnostics(body: string) {
  const all = body.slice(0, DIAGNOSTIC_RULES.maxBytes).replace(/\r/g, "").split("\n");
  let bootNumber: number | null = null;
  let reason: string | null = null;
  if (all.length && /^(BOOT|RST)=/i.test(all[0].trim())) {
    for (const part of all.shift()!.split(/[;&,]/)) {
      const [k, v = ""] = part.split("=");
      if (/^boot$/i.test(k.trim()) && /^\d{1,9}$/.test(v.trim())) bootNumber = Number(v.trim());
      if (/^rst$/i.test(k.trim()) && v.trim()) reason = restartReason(v) ?? v.trim().slice(0, 40);
    }
  }
  const lines = all
    .map((l) => l.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trimEnd().slice(0, DIAGNOSTIC_RULES.maxLineChars))
    .filter((l) => l.trim())
    .slice(-DIAGNOSTIC_RULES.maxLines);
  return { bootNumber, restartReason: reason, lines };
}

/** Stores a report from a known device (unknown devices can't post logs) and keeps only the latest ones. */
export async function saveDiagnostics(db: Db, deviceId: string, body: string, now = new Date()) {
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  if (!device) throw new DiagnosticsError("Unknown device");
  const report = parseDiagnostics(body);
  if (!report.lines.length && !report.restartReason) return null;
  const [row] = await db
    .insert(deviceDiagnostics)
    .values({ deviceId, receivedAt: now, bootNumber: report.bootNumber, restartReason: report.restartReason, lines: report.lines })
    .returning({ id: deviceDiagnostics.id });
  const keep = await db
    .select({ id: deviceDiagnostics.id })
    .from(deviceDiagnostics)
    .where(eq(deviceDiagnostics.deviceId, deviceId))
    .orderBy(desc(deviceDiagnostics.receivedAt), desc(deviceDiagnostics.id))
    .limit(DIAGNOSTIC_RULES.keepPerDevice);
  await db.delete(deviceDiagnostics).where(and(eq(deviceDiagnostics.deviceId, deviceId), notInArray(deviceDiagnostics.id, keep.map((k) => k.id))));
  return row.id;
}

/** Nightly clean-up: reports older than keepDays. */
export async function deleteOldDiagnostics(db: Db, now = new Date()) {
  const rows = await db
    .delete(deviceDiagnostics)
    .where(lt(deviceDiagnostics.receivedAt, new Date(now.getTime() - DIAGNOSTIC_RULES.keepDays * 86_400_000)))
    .returning({ id: deviceDiagnostics.id });
  return rows.length;
}
