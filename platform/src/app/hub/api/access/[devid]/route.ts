import { timingSafeEqual } from "node:crypto";
import { getDb } from "@/lib/db";
import { afterCheckin } from "@/lib/alert-jobs";
import { accessSignature, deviceKey, resumeSignature } from "@/lib/commands";
import { beaconCheckIn, RelayError, resumeCheckIn } from "@/lib/relay";
import { isValidDeviceId } from "@/lib/telemetry/ingest";
import { deviceReply } from "@/lib/freematics/reply";

/**
 * A relay device (Safety & Access Control, our firmware) let an operator start (docs/starter-relay.md):
 *  - with their Bluetooth beacon or an app pass: GET /hub/api/access/<DEVICE_ID>?op=<operator id>&b=<beacon|APP>&t=<unix time>&sig=<signature>
 *    → a beacon / app check-in;
 *  - after a break, with the phone of the operator whose check-in it was holding (session hold, docs/operator-app.md):
 *    GET /hub/api/access/<DEVICE_ID>?op=<operator id>&c=<check-in id>&t=<unix time>&sig=<signature> → that check-in carries on.
 * Sent when it happens, or later if the machine was out of coverage.
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/access/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);
  const q = new URL(request.url).searchParams;
  const operatorId = Number(q.get("op"));
  const beacon = (q.get("b") ?? "").slice(0, 31);
  const checkinId = q.has("c") ? Number(q.get("c")) : null;
  const t = Number(q.get("t"));
  const validId = (n: number) => Number.isSafeInteger(n) && n > 0;
  if (!validId(operatorId) || (checkinId === null ? !beacon : !validId(checkinId)) || !Number.isFinite(t) || t <= 0) return deviceReply("Bad request", 400);
  const key = deviceKey(devid);
  if (key) {
    const expected = Buffer.from(checkinId !== null ? resumeSignature(key, devid, operatorId, checkinId, t) : accessSignature(key, devid, operatorId, beacon, t));
    const given = Buffer.from(q.get("sig") ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return deviceReply("Bad signature", 403);
  }
  try {
    const db = getDb();
    const at = new Date(t * 1000);
    const id = checkinId !== null ? await resumeCheckIn(db, devid, { operatorId, checkinId, at }) : await beaconCheckIn(db, devid, { operatorId, beacon, at });
    afterCheckin(id);
    return deviceReply("OK");
  } catch (err) {
    // Answered with 200 anyway: the device must not keep resending something VS-lab can't use.
    if (err instanceof RelayError) return deviceReply(`IGNORED ${err.message}`);
    throw err;
  }
}
