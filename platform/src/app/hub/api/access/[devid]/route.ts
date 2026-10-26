import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { afterCheckin } from "@/lib/alert-jobs";
import { accessSignature, deviceKey } from "@/lib/commands";
import { beaconCheckIn, RelayError } from "@/lib/relay";
import { isValidDeviceId } from "@/lib/telemetry/ingest";
import { deviceReply } from "@/lib/freematics/reply";

/**
 * A relay device (Safety & Access Control, our firmware) let an operator start with their Bluetooth beacon
 * (docs/starter-relay.md): GET /hub/api/access/<DEVICE_ID>?op=<operator id>&b=<beacon>&t=<unix time>&sig=<signature>.
 * Sent when it happens, or later if the machine was out of coverage. Becomes a beacon check-in.
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/access/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);
  const q = new URL(request.url).searchParams;
  const operatorId = Number(q.get("op"));
  const beacon = (q.get("b") ?? "").slice(0, 31);
  const t = Number(q.get("t"));
  if (!Number.isSafeInteger(operatorId) || operatorId <= 0 || !beacon || !Number.isFinite(t) || t <= 0) return deviceReply("Bad request", 400);
  const key = deviceKey(devid);
  if (key) {
    const expected = Buffer.from(accessSignature(key, devid, operatorId, beacon, t));
    const given = Buffer.from(q.get("sig") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deviceReply("Bad signature", 403);
  }
  try {
    const checkinId = await beaconCheckIn(getDb(), devid, { operatorId, beacon, at: new Date(t * 1000) });
    afterCheckin(checkinId);
    return deviceReply("OK");
  } catch (err) {
    // Answered with 200 anyway: the device must not keep resending something VS-lab can't use.
    if (err instanceof RelayError) return deviceReply(`IGNORED ${err.message}`);
    throw err;
  }
}
