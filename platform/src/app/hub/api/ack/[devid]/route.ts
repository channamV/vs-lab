import { getDb } from "@/lib/db";
import { CommandError, recordAnswer } from "@/lib/commands";
import { afterUpdateAnswer } from "@/lib/firmware";
import { confirmMode } from "@/lib/modes";
import { isValidDeviceId } from "@/lib/telemetry/ingest";
import { deviceReply } from "@/lib/freematics/reply";

/**
 * A device's answer to a command (our firmware fork; see docs/device-commands.md):
 * GET /hub/api/ack/<DEVICE_ID>?id=<command id>&ok=1|0&result=<text>&sig=<signature>
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/ack/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);
  const q = new URL(request.url).searchParams;
  const id = Number(q.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return deviceReply("Bad command ID", 400);
  try {
    const command = await recordAnswer(getDb(), devid, { id, ok: q.get("ok") === "1", result: q.get("result") ?? "", sig: q.get("sig") });
    // A finished firmware update: the device now runs that version.
    await afterUpdateAnswer(getDb(), command);
    // A relay machine confirming the mode it now enforces.
    await confirmMode(getDb(), devid, command.command, command.status === "done");
    return deviceReply("OK");
  } catch (err) {
    if (err instanceof CommandError) return deviceReply(err.message, err.message === "Bad signature" ? 403 : 404);
    throw err;
  }
}
