import "server-only";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { checkUnauthorizedUse, raiseCheckinAlerts } from "@/lib/alerts";
import { eq } from "drizzle-orm";
import { checkins } from "@/lib/db/schema";
import { deliverAlerts, processEvents, recordEvent } from "@/lib/notifications";
import { syncCheckins } from "@/lib/operators";
import { pairedMachineId } from "@/lib/telemetry/ingest";
import { notifyIncidents, watchdog } from "@/lib/tamper";
import { checkDwell } from "@/lib/worksites";

/**
 * Runs alert rules after the response has been sent, so devices and operators never wait on them
 * (and a problem here can never turn a device's HTTP 200 into an error).
 */

export function afterDeviceReport(deviceId: string) {
  after(async () => {
    try {
      const db = getDb();
      // Check-ins and alerts belong to the machine the device is on; an unpaired device has none.
      const machineId = await pairedMachineId(db, deviceId);
      if (!machineId) return;
      // First link/end check-ins to match the engine (automatic check-out), then check for unauthorized use.
      await syncCheckins(db, machineId);
      await deliverAlerts(db, await checkUnauthorizedUse(db, machineId));
      // Tamper: quiet spell ended, moved while quiet, different vehicle, power interrupted.
      await deliverAlerts(db, await notifyIncidents(db, { machineId }));
      // Engine starts/stops and connectivity changes recorded by this report.
      await processEvents(db, { machineId });
    } catch (err) {
      console.error("Check-in sync / unauthorized-use check failed", deviceId, err);
    }
  });
}

export function afterCheckin(checkinId: number) {
  after(async () => {
    try {
      const db = getDb();
      await deliverAlerts(db, await raiseCheckinAlerts(db, checkinId));
      // Locked out for repair: an "Equipment Locked" notification (with the operator who did it).
      const [c] = await db.select().from(checkins).where(eq(checkins.id, checkinId));
      if (c?.lockoutRequested) {
        const id = await recordEvent(db, {
          organizationId: c.organizationId,
          machineId: c.machineId,
          type: "equipment_locked",
          operatorId: c.operatorId,
          occurredAt: c.startedAt,
        });
        if (id) await processEvents(db, { eventIds: [id] });
      }
    } catch (err) {
      console.error("Check-in alerts failed", checkinId, err);
    }
  });
}

/** Delivers events recorded by an admin action (machine added or changed, approvals changed). */
export function afterEvents(eventIds: (number | null)[]) {
  const ids = eventIds.filter((id) => id !== null);
  if (ids.length === 0) return;
  after(async () => {
    try {
      await processEvents(getDb(), { eventIds: ids });
    } catch (err) {
      console.error("Notifications failed", ids, err);
    }
  });
}

/** The tamper watchdog (every 5 minutes, from Vercel Cron): find quiet devices, then alert and notify. */
export async function runWatchdog(now = new Date()) {
  const db = getDb();
  const result = await watchdog(db, now);
  const raised = await notifyIncidents(db, {}, now);
  await deliverAlerts(db, raised);
  // Machines that have stayed at a worksite longer than its limit.
  const dwell = await checkDwell(db, now);
  // Connectivity and worksite notifications for every machine with something pending.
  await processEvents(db, {}, now);
  return { ...result, alerts: raised.length, worksiteDwell: dwell };
}
