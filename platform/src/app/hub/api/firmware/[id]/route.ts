import { getDb } from "@/lib/db";
import { authorizeDownload, byteRange, readFirmwareFile } from "@/lib/firmware";
import { isValidDeviceId } from "@/lib/telemetry/ingest";

/**
 * Firmware download for a device that was sent an update (our firmware fork; docs/firmware-updates.md):
 * GET /hub/api/firmware/<release>?d=<DEVICE_ID>&s=<signature>. The path comes in the UPDATE command.
 * Devices download it in pieces (cellular modems fail on the whole file at once): a standard Range header,
 * or &o=<offset>&n=<length> → 206 with that part. The device checks the size and SHA-256 of the whole
 * file (also in the command) before installing.
 */
export async function GET(request: Request, ctx: RouteContext<"/hub/api/firmware/[id]">) {
  const releaseId = Number((await ctx.params).id);
  const q = new URL(request.url).searchParams;
  const deviceId = q.get("d") ?? "";
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0 || !isValidDeviceId(deviceId)) return new Response("Bad request", { status: 400 });
  const db = getDb();
  const release = await authorizeDownload(db, releaseId, deviceId, q.get("s"));
  if (!release) return new Response("Not available", { status: 403 });
  const file = await readFirmwareFile(release.storageKey);
  if (!file) return new Response("File missing", { status: 404 });

  const headers = {
    "Content-Type": "application/octet-stream",
    "Accept-Ranges": "bytes",
    "X-Firmware-Version": release.version,
    "X-Firmware-SHA256": release.sha256,
    ETag: `"${release.sha256}"`,
    "Cache-Control": "no-store",
  };
  const range = byteRange(file.length, request.headers.get("range"), q.get("o"), q.get("n"));
  if (range === "invalid") return new Response("Range not satisfiable", { status: 416, headers: { ...headers, "Content-Range": `bytes */${file.length}` } });
  if (range === null) {
    return new Response(file as BodyInit, {
      headers: { ...headers, "Content-Length": String(file.length), "Content-Disposition": `attachment; filename="${release.version}.bin"` },
    });
  }
  const part = file.subarray(range.start, range.end + 1);
  return new Response(part as BodyInit, {
    status: 206,
    headers: { ...headers, "Content-Length": String(part.length), "Content-Range": `bytes ${range.start}-${range.end}/${file.length}` },
  });
}
