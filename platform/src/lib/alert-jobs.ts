import "server-only";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { checkUnauthorizedUse, raiseCheckinAlerts } from "@/lib/alerts";
import { eq } from "drizzle-orm";
import { checkins } from "@/lib/db/schema";
import { deliverAlerts, processEvents, recordEvent } from "@/lib/notifications";
import { syncCheckins } from "@/lib/operators";
import { pairedMachineId } from "@/lib/telemetry/ingest";

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
      // Engine starts/stops recorded by this report (operator filled in from the synced check-in).
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
