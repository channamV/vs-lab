import { getDb } from "@/lib/db";
import { authorizeDownload, readFirmwareFile } from "@/lib/firmware";
import { isValidDeviceId } from "@/lib/telemetry/ingest";

/**
 * Firmware download for a device that was sent an update (our firmware fork; docs/firmware-updates.md):
 * GET /hub/api/firmware/<release>?d=<DEVICE_ID>&s=<signature>. The path comes in the UPDATE command.
 * The device checks the size and SHA-256 (also in the command) before installing.
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/firmware/[id]">) {
  const releaseId = Number((await ctx.params).id);
  const q = new URL(request.url).searchParams;
  const deviceId = q.get("d") ?? "";
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !isValidDeviceId(deviceId)) return new Response("Bad request", { status: 400 });
  const db = getDb();
  const release = await authorizeDownload(db, releaseId, deviceId, q.get("s"));
  if (!release) return new Response("Not available", { status: 403 });
  const body = await readFirmwareFile(release.storageKey);
  if (!body) return new Response("File missing", { status: 404 });
  return new Response(body as BodyInit, {
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Length": String(release.bytes),
      "Content-Disposition": `attachment; filename="${release.version}.bin"`,
      "X-Firmware-Version": release.version,
      "X-Firmware-SHA256": release.sha256,
      "Cache-Control": "no-store",
    },
  });
}
