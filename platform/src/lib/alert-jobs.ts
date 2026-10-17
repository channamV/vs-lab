import "server-only";
import { after } from "next/server";
import { getDb } from "@/lib/db";
import { checkUnauthorizedUse, raiseCheckinAlerts } from "@/lib/alerts";
import { deliverAlerts } from "@/lib/notify";
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
    } catch (err) {
      console.error("Check-in alerts failed", checkinId, err);
    }
  });
}
