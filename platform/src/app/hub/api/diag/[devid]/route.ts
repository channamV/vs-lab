import { getDb } from "@/lib/db";
import { DiagnosticsError, saveDiagnostics } from "@/lib/diagnostics";
import { deviceReply } from "@/lib/freematics/reply";
import { isValidDeviceId } from "@/lib/telemetry/ingest";

/**
 * Restart report from our firmware (docs/device-diagnostics.md): POST /hub/api/diag/<DEVICE_ID> with
 * `BOOT=<n>;RST=<reason>` on the first line and the device's last log lines after it.
 */
export async function POST(request: Request, ctx: RouteContext<"/hub/api/diag/[devid]">) {
  const { devid } = await ctx.params;
  if (!isValidDeviceId(devid)) return deviceReply("Bad device ID", 400);
  try {
    await saveDiagnostics(getDb(), devid, await request.text());
    return deviceReply("OK");
  } catch (err) {
    if (err instanceof DiagnosticsError) return deviceReply(err.message, 403);
    throw err;
  }
}
