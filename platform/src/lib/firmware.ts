import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";
import { and, asc, desc, eq, inArray, isNull, ne } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceAssignments, deviceCommands, devices, firmwareReleases, machines, organizations, type DeviceCommand } from "@/lib/db/schema";
import { deviceKey } from "@/lib/commands";

/**
 * Over-the-air firmware updates, platform side (docs/firmware-updates.md). The device side (download, check,
 * install into the spare slot, roll back if the new version doesn't come up) is our firmware fork.
 *
 * 1. Staff upload a build (Platform → Firmware). We keep the file privately and record its SHA-256.
 * 2. Staff send it to chosen devices in stages (one bench device, a few pilots, then everyone). Each device
 *    gets an UPDATE command through the normal command queue (src/lib/commands.ts):
 *      UPDATE=<version>\t<bytes>\t<sha256>\t<download path>
 *    The path is /hub/api/firmware/<release>?d=<device>&s=<signature>, only valid for devices sent the update.
 * 3. The device downloads, checks size and SHA-256, installs, restarts, and answers the command with the
 *    version it's now running. It also reports its version (FW=) every time it signs in.
 * The stock Telelogger ignores the command (it ignores replies), so sending one to a stock device is harmless.
 */
export const FIRMWARE_RULES = {
  /** ESP32 builds are ~1–2 MB. Uploads go through a server action (4 MB limit, Vercel ~4.5 MB). */
  maxBytes: 3_900_000,
  minBytes: 50_000,
  /** Update commands wait this long for the device (it may be parked, checking in every 15 minutes). */
  expiresDays: 7,
  versionPattern: /^[A-Za-z0-9._+-]{1,40}$/,
};

export class FirmwareError extends Error {}

const OPEN = ["pending", "sent"];

// ---------- Storage (same private Blob store as photos; .data/firmware on your own computer) ----------

const localDir = () => process.env.FIRMWARE_DIR || path.join(process.cwd(), ".data", "firmware");

async function saveFile(key: string, data: Uint8Array) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put(key, Buffer.from(data), { access: "private", contentType: "application/octet-stream", addRandomSuffix: false });
    return;
  }
  if (process.env.VERCEL) throw new FirmwareError("File storage isn't set up (BLOB_READ_WRITE_TOKEN missing).");
  const full = path.join(/*turbopackIgnore: true*/ localDir(), key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, data);
}

/**
 * A release's file. Devices download in pieces (see byteRange), so the last file read is kept in memory:
 * one update means dozens of requests for the same ~1.5 MB file, and a warm server instance reuses it.
 */
let cached: { key: string; data: Uint8Array } | null = null;

export async function readFirmwareFile(key: string): Promise<Uint8Array | null> {
  if (cached?.key === key) return cached.data;
  let data: Uint8Array | null = null;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const stream = (await get(key, { access: "private" }))?.stream;
    if (stream) data = new Uint8Array(await new Response(stream).arrayBuffer());
  } else if (!key.includes("..")) {
    try {
      data = new Uint8Array(await readFile(path.join(/*turbopackIgnore: true*/ localDir(), key)));
    } catch {
      data = null;
    }
  }
  if (data) cached = { key, data };
  return data;
}

/**
 * A piece as the device asked for it: raw bytes, or Base64 text with `&e=b64`. Our firmware asks for Base64:
 * the SIM7670 modem's HTTP commands don't pass all binary data through (a 1 KB block starting with zero bytes
 * came back empty, desk test 2026-10-27), and Base64 has no such bytes (a third more data). Null for an unknown
 * encoding.
 */
export function encodePart(part: Uint8Array, encoding: string | null): Uint8Array | null {
  if (encoding === null || encoding === "") return part;
  if (encoding === "b64") return new Uint8Array(Buffer.from(Buffer.from(part).toString("base64"), "ascii"));
  return null;
}

/**
 * Which part of the file a device asked for: a standard `Range: bytes=<start>-<end>` header, or, for modems
 * whose built-in HTTP can't set headers, `&o=<offset>&n=<length>` on the URL. Returns null for the whole
 * file, "invalid" when the range can't be served (HTTP 416).
 */
export function byteRange(size: number, rangeHeader: string | null, offset: string | null, length: string | null): { start: number; end: number } | null | "invalid" {
  let start: number;
  let end: number;
  if (offset !== null || length !== null) {
    start = Number(offset ?? 0);
    const n = Number(length ?? size - start);
    if (!Number.isInteger(start) || !Number.isInteger(n) || start < 0 || n <= 0) return "invalid";
    end = start + n - 1;
  } else if (rangeHeader) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (!m || (m[1] === "" && m[2] === "")) return "invalid";
    if (m[1] === "") {
      // "bytes=-500": the last 500 bytes.
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === "" ? size - 1 : Number(m[2]);
    }
  } else return null;
  if (start >= size || end < start) return "invalid";
  return { start, end: Math.min(end, size - 1) };
}

// ---------- Releases ----------

export async function createRelease(
  db: Db,
  input: { version: string; notes: string; fileName: string; data: Uint8Array; uploadedBy: string },
) {
  const version = input.version.trim();
  if (!FIRMWARE_RULES.versionPattern.test(version)) {
    throw new FirmwareError("The version can only use letters, numbers, dots, dashes, + and _ (e.g. vs-1.0.3), up to 40 characters.");
  }
  if (input.data.length < FIRMWARE_RULES.minBytes || input.data.length > FIRMWARE_RULES.maxBytes) {
    throw new FirmwareError(`The file must be between ${FIRMWARE_RULES.minBytes / 1000} KB and ${(FIRMWARE_RULES.maxBytes / 1e6).toFixed(1)} MB. Is it the firmware .bin?`);
  }
  // An ESP32 app image starts with the magic byte 0xE9.
  if (input.data[0] !== 0xe9) throw new FirmwareError("That doesn't look like an ESP32 firmware file (.bin from the build).");
  const [taken] = await db.select({ id: firmwareReleases.id }).from(firmwareReleases).where(eq(firmwareReleases.version, version));
  if (taken) throw new FirmwareError(`Version ${version} has already been uploaded. Give the new build a new version.`);
  const sha256 = createHash("sha256").update(input.data).digest("hex");
  const storageKey = `firmware/${version}-${randomBytes(6).toString("hex")}.bin`;
  await saveFile(storageKey, input.data);
  const [release] = await db
    .insert(firmwareReleases)
    .values({
      version,
      notes: input.notes.trim().slice(0, 1000) || null,
      fileName: input.fileName.slice(0, 120) || "firmware.bin",
      storageKey,
      sha256,
      bytes: input.data.length,
      uploadedBy: input.uploadedBy,
    })
    .returning();
  return release;
}

/** Retired releases stay listed (devices may still run them) but can't be sent; open updates are cancelled. */
export async function retireRelease(db: Db, id: number, now = new Date()) {
  await db.update(firmwareReleases).set({ retiredAt: now }).where(and(eq(firmwareReleases.id, id), isNull(firmwareReleases.retiredAt)));
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.firmwareReleaseId, id), inArray(deviceCommands.status, OPEN)));
}

// ---------- Sending updates ----------

const sign = (key: string, text: string) => createHmac("sha256", key).update(text).digest("hex").slice(0, 16);
export const downloadSignature = (key: string, deviceId: string, releaseId: number) => sign(key, `fw\n${deviceId}\n${releaseId}`);

export function downloadPath(deviceId: string, releaseId: number) {
  const key = deviceKey(deviceId);
  const s = key ? downloadSignature(key, deviceId, releaseId) : "-";
  return `/hub/api/firmware/${releaseId}?d=${encodeURIComponent(deviceId)}&s=${s}`;
}

/**
 * Queues the update for these devices. Skips devices already on this version or already waiting for it;
 * cancels a device's open update to a different version (the newest choice wins).
 */
export async function queueUpdate(db: Db, releaseId: number, deviceIds: string[], createdBy: string, now = new Date()) {
  const [release] = await db.select().from(firmwareReleases).where(eq(firmwareReleases.id, releaseId));
  if (!release) throw new FirmwareError("Release not found.");
  if (release.retiredAt) throw new FirmwareError("This release has been retired.");
  const ids = [...new Set(deviceIds)];
  if (ids.length === 0) throw new FirmwareError("Choose at least one device.");
  const [found, open] = await Promise.all([
    // Retired devices (out of service) never get updates.
    db
      .select({ id: devices.id, firmwareVersion: devices.firmwareVersion })
      .from(devices)
      .where(and(inArray(devices.id, ids), isNull(devices.retiredAt))),
    db
      .select({ deviceId: deviceCommands.deviceId })
      .from(deviceCommands)
      .where(and(inArray(deviceCommands.deviceId, ids), eq(deviceCommands.firmwareReleaseId, releaseId), inArray(deviceCommands.status, OPEN))),
  ]);
  const waiting = new Set(open.map((o) => o.deviceId));
  let queued = 0;
  let skipped = ids.length - found.length;
  for (const d of found) {
    if (d.firmwareVersion === release.version || waiting.has(d.id)) {
      skipped++;
      continue;
    }
    await db
      .update(deviceCommands)
      .set({ status: "cancelled" })
      .where(
        and(
          eq(deviceCommands.deviceId, d.id),
          inArray(deviceCommands.status, OPEN),
          ne(deviceCommands.firmwareReleaseId, releaseId),
        ),
      );
    await db.insert(deviceCommands).values({
      deviceId: d.id,
      command: `UPDATE=${release.version}\t${release.bytes}\t${release.sha256}\t${downloadPath(d.id, release.id)}`,
      label: `Update firmware to ${release.version}`,
      createdBy,
      createdAt: now,
      expiresAt: new Date(now.getTime() + FIRMWARE_RULES.expiresDays * 86_400_000),
      firmwareReleaseId: release.id,
    });
    queued++;
  }
  return { queued, skipped };
}

/** Cancels this release's updates that haven't been answered yet. */
export async function cancelUpdates(db: Db, releaseId: number) {
  const rows = await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.firmwareReleaseId, releaseId), inArray(deviceCommands.status, OPEN)))
    .returning({ id: deviceCommands.id });
  return rows.length;
}

/**
 * May this device download this release? Only devices that were sent the update (not cancelled), with a
 * valid signature when signing is set up. Returns the release, or null.
 */
export async function authorizeDownload(db: Db, releaseId: number, deviceId: string, signature: string | null) {
  const key = deviceKey(deviceId);
  if (key) {
    const expected = Buffer.from(downloadSignature(key, deviceId, releaseId));
    const given = Buffer.from(signature ?? "");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  }
  const [row] = await db
    .select({ release: firmwareReleases })
    .from(deviceCommands)
    .innerJoin(firmwareReleases, eq(firmwareReleases.id, deviceCommands.firmwareReleaseId))
    .where(
      and(
        eq(deviceCommands.deviceId, deviceId),
        eq(deviceCommands.firmwareReleaseId, releaseId),
        inArray(deviceCommands.status, ["pending", "sent", "done", "failed", "expired"]),
        isNull(firmwareReleases.retiredAt),
      ),
    )
    .limit(1);
  return row?.release ?? null;
}

// ---------- Versions reported by devices ----------

/** The version the device says it's running (FW= when it signs in). Ignores anything malformed. */
export async function noteFirmwareVersion(db: Db, deviceId: string, version: string | null, now = new Date()) {
  const v = version?.trim();
  if (!v || !FIRMWARE_RULES.versionPattern.test(v)) return;
  await db.update(devices).set({ firmwareVersion: v, firmwareReportedAt: now }).where(eq(devices.id, deviceId));
}

/** After a device answers an update: success means it's now running that release. */
export async function afterUpdateAnswer(db: Db, command: DeviceCommand, now = new Date()) {
  if (!command.firmwareReleaseId || command.status !== "done") return;
  const [release] = await db.select({ version: firmwareReleases.version }).from(firmwareReleases).where(eq(firmwareReleases.id, command.firmwareReleaseId));
  if (release) await noteFirmwareVersion(db, command.deviceId, release.version, now);
}

// ---------- Staff pages ----------

export type UpdateState = "waiting" | "sent" | "done" | "failed" | "expired" | "cancelled";

/** Every release, newest first, with how many devices run it and how its updates are going. */
export async function listReleases(db: Db) {
  const [releases, deviceRows, commands] = await Promise.all([
    db.select().from(firmwareReleases).orderBy(desc(firmwareReleases.createdAt)),
    db.select({ version: devices.firmwareVersion }).from(devices),
    db
      .select({ releaseId: deviceCommands.firmwareReleaseId, status: deviceCommands.status })
      .from(deviceCommands)
      .where(inArray(deviceCommands.firmwareReleaseId, db.select({ id: firmwareReleases.id }).from(firmwareReleases))),
  ]);
  return releases.map((r) => {
    const mine = commands.filter((c) => c.releaseId === r.id);
    const count = (...s: string[]) => mine.filter((c) => s.includes(c.status)).length;
    return {
      ...r,
      running: deviceRows.filter((d) => d.version === r.version).length,
      updates: { waiting: count("pending", "sent"), done: count("done"), failed: count("failed", "expired") },
    };
  });
}

/** One release and every device, with its current version and its latest update to this release. */
export async function releaseRollout(db: Db, releaseId: number) {
  const [release] = await db.select().from(firmwareReleases).where(eq(firmwareReleases.id, releaseId));
  if (!release) return null;
  const [rows, commands] = await Promise.all([
    db
      .select({
        id: devices.id,
        firmwareVersion: devices.firmwareVersion,
        firmwareReportedAt: devices.firmwareReportedAt,
        lastSeenAt: devices.lastSeenAt,
        stockOrganization: organizations.name,
        machineName: machines.name,
        unitNumber: machines.unitNumber,
        machineOrganizationId: machines.organizationId,
      })
      .from(devices)
      .leftJoin(organizations, eq(organizations.id, devices.organizationId))
      .leftJoin(deviceAssignments, and(eq(deviceAssignments.deviceId, devices.id), isNull(deviceAssignments.endedAt)))
      .leftJoin(machines, eq(machines.id, deviceAssignments.machineId))
      .where(isNull(devices.retiredAt)) // out of service: not offered
      .orderBy(asc(devices.id)),
    db.select().from(deviceCommands).where(eq(deviceCommands.firmwareReleaseId, releaseId)).orderBy(asc(deviceCommands.id)),
  ]);
  const latest = new Map(commands.map((c) => [c.deviceId, c]));
  const stateOf = (c: DeviceCommand | undefined): UpdateState | null =>
    !c ? null : c.status === "pending" ? "waiting" : (c.status as UpdateState);
  return {
    release,
    devices: rows.map((d) => {
      const c = latest.get(d.id);
      return { ...d, update: c ? { state: stateOf(c)!, at: c.answeredAt ?? c.sentAt ?? c.createdAt, result: c.result } : null };
    }),
  };
}
