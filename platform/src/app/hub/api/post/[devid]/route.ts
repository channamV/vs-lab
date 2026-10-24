import { getDb } from "@/lib/db";
import { commandsForReply, withCommands } from "@/lib/commands";
import { afterDeviceReport } from "@/lib/alert-jobs";
import { parsePayload } from "@/lib/freematics/protocol";
import { ingestSamples, isValidDeviceId, UnknownDeviceError } from "@/lib/telemetry/ingest";
import { deviceReply } from "@/lib/freematics/reply";

/**
 * Telemetry upload from the Freematics Telelogger ("HTTPS POST" transport).
 * The device sends: POST /hub/api/post/<DEVICE_ID> with the sample text as the body.
 */
export async function POST(request: Request, ctx: RouteContext<"/hub/api/post/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);

  const parsed = parsePayload(await request.text());
  if (parsed.checksumValid === false) return deviceReply("Bad checksum", 400);

  try {
    const count = await ingestSamples(getDb(), devid, parsed.samples);
    afterDeviceReport(devid);
    return deviceReply(withCommands(`OK ${count}`, await commandsForReply(getDb(), devid)));
  } catch (err) {
    if (err instanceof UnknownDeviceError) return deviceReply("Unknown device", 403);
    throw err;
  }
}
