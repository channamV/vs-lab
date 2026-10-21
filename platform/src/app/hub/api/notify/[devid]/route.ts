import { getDb } from "@/lib/db";
import { commandsForReply, withCommands } from "@/lib/commands";
import { EVENT_NAMES } from "@/lib/freematics/protocol";
import { isValidDeviceId, recordEvent, UnknownDeviceError } from "@/lib/telemetry/ingest";

/**
 * Connection events from the Freematics Telelogger (login, logout, ping...).
 * The device sends: GET /hub/api/notify/<DEVICE_ID>?EV=<code>&SSI=<rssi>&VIN=<vin>
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/notify/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return new Response("Bad device ID", { status: 400 });

  const q = new URL(request.url).searchParams;
  const ev = Number(q.get("EV"));
  const rssi = Number(q.get("SSI"));
  try {
    await recordEvent(getDb(), devid, {
      type: EVENT_NAMES[ev] ?? `event_${q.get("EV") ?? "unknown"}`,
      rssi: q.has("SSI") && Number.isFinite(rssi) && rssi !== 0 ? rssi : null,
      vin: q.get("VIN") || null,
    });
    return new Response(withCommands("OK", await commandsForReply(getDb(), devid)));
  } catch (err) {
    if (err instanceof UnknownDeviceError) return new Response("Unknown device", { status: 403 });
    throw err;
  }
}
