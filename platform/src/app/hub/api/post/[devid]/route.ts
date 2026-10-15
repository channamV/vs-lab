import { getDb } from "@/lib/db";
import { parsePayload } from "@/lib/freematics/protocol";
import { ingestSamples, isValidDeviceId, UnknownDeviceError } from "@/lib/telemetry/ingest";

/**
 * Telemetry upload from the Freematics Telelogger ("HTTPS POST" transport).
 * The device sends: POST /hub/api/post/<DEVICE_ID> with the sample text as the body.
 */
export async function POST(request: Request, ctx: RouteContext<"/hub/api/post/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return new Response("Bad device ID", { status: 400 });

  const parsed = parsePayload(await request.text());
  if (parsed.checksumValid === false) return new Response("Bad checksum", { status: 400 });

  try {
    const count = await ingestSamples(getDb(), devid, parsed.samples);
    return new Response(`OK ${count}`);
  } catch (err) {
    if (err instanceof UnknownDeviceError) return new Response("Unknown device", { status: 403 });
    throw err;
  }
}
