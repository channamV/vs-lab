import { getDb } from "@/lib/db";
import { commandsForReply, withCommands } from "@/lib/commands";
import { EVENT_NAMES } from "@/lib/freematics/protocol";
import { noteFirmwareVersion } from "@/lib/firmware";
import { isValidDeviceId, recordEvent, UnknownDeviceError } from "@/lib/telemetry/ingest";
import { deviceReply } from "@/lib/freematics/reply";
import { afterDeviceReport } from "@/lib/alert-jobs";

/**
 * Connection events from the Freematics Telelogger (login, logout, ping...).
 * The device sends: GET /hub/api/notify/<DEVICE_ID>?EV=<code>&SSI=<rssi>&VIN=<vin>
 * Our firmware fork adds &FW=<version> (docs/firmware-updates.md).
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/notify/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);

  const q = new URL(request.url).searchParams;
  const ev = Number(q.get("EV"));
  const rssi = Number(q.get("SSI"));
  try {
    await recordEvent(getDb(), devid, {
      type: EVENT_NAMES[ev] ?? `event_${q.get("EV") ?? "unknown"}`,
      rssi: q.has("SSI") && Number.isFinite(rssi) && rssi !== 0 ? rssi : null,
      vin: q.get("VIN") || null,
    });
    if (q.has("FW")) await noteFirmwareVersion(getDb(), devid, q.get("FW"));
    // A sign-off can end the engine-on period: automatic check-out and the "stopped" notification follow.
    afterDeviceReport(devid);
    return deviceReply(withCommands("OK", await commandsForReply(getDb(), devid)));
  } catch (err) {
    if (err instanceof UnknownDeviceError) return deviceReply("Unknown device", 403);
    throw err;
  }
}
