import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceCommands, devices } from "@/lib/db/schema";
import { commandsForReply, recordAnswer } from "@/lib/commands";
import {
  afterUpdateAnswer,
  authorizeDownload,
  byteRange,
  cancelUpdates,
  createRelease,
  downloadSignature,
  FirmwareError,
  listReleases,
  noteFirmwareVersion,
  queueUpdate,
  readFirmwareFile,
  releaseRollout,
  retireRelease,
} from "./firmware";
import { deviceKey } from "./commands";

let db: Db;
const t0 = new Date("2026-10-22T13:00:00Z");
/** A fake ESP32 image: magic byte 0xE9, then filler. */
const image = (size = 100_000, fill = 1) => {
  const data = new Uint8Array(size).fill(fill);
  data[0] = 0xe9;
  return data;
};
const upload = (version: string, data = image()) => createRelease(db, { version, notes: "Fixes", fileName: "telelogger.bin", data, uploadedBy: "craig@veristart.ca" });

beforeEach(async () => {
  process.env.FIRMWARE_DIR = mkdtempSync(path.join(tmpdir(), "fw-"));
  db = createDb();
  await migrateDb(db, false);
  await db.insert(devices).values([{ id: "DEV1" }, { id: "DEV2" }, { id: "DEV3", firmwareVersion: "vs-1.1.0" }]);
});
afterEach(() => {
  delete process.env.DEVICE_KEY_SECRET;
});

describe("releases", () => {
  it("stores the file with its fingerprint", async () => {
    const data = image();
    const r = await upload("vs-1.1.0", data);
    expect(r).toMatchObject({ version: "vs-1.1.0", bytes: 100_000, sha256: createHash("sha256").update(data).digest("hex") });
    expect(await readFirmwareFile(r.storageKey)).toEqual(data);
  });

  it("rejects bad versions, duplicates and files that aren't firmware", async () => {
    await expect(upload("1.0 beta")).rejects.toThrow(FirmwareError);
    await expect(upload("vs-1", new Uint8Array(100_000))).rejects.toThrow(/doesn't look like an ESP32/);
    await expect(upload("vs-1", image(1000))).rejects.toThrow(/between/);
    await upload("vs-1");
    await expect(upload("vs-1")).rejects.toThrow(/already been uploaded/);
  });
});

describe("rollout", () => {
  it("queues UPDATE commands, skipping devices already on the version", async () => {
    const r = await upload("vs-1.1.0");
    expect(await queueUpdate(db, r.id, ["DEV1", "DEV3", "NOPE"], "craig", t0)).toEqual({ queued: 1, skipped: 2 });
    expect(await queueUpdate(db, r.id, ["DEV1"], "craig", t0)).toEqual({ queued: 0, skipped: 1 }); // already waiting
    const [line] = await commandsForReply(db, "DEV1", t0);
    expect(line).toMatch(new RegExp(`^CMD \\d+ - UPDATE=vs-1\\.1\\.0\\t100000\\t${r.sha256}\\t/hub/api/firmware/${r.id}\\?d=DEV1&s=-$`));
    const [cmd] = await db.select().from(deviceCommands);
    expect(cmd.expiresAt).toEqual(new Date(t0.getTime() + 7 * 86_400_000));
  });

  it("a newer choice replaces a waiting update", async () => {
    const a = await upload("vs-1.1.0");
    const b = await upload("vs-1.2.0", image(100_000, 2));
    await queueUpdate(db, a.id, ["DEV1"], "craig", t0);
    await queueUpdate(db, b.id, ["DEV1"], "craig", t0);
    const rows = await db.select().from(deviceCommands).orderBy(deviceCommands.id);
    expect(rows.map((c) => [c.firmwareReleaseId, c.status])).toEqual([
      [a.id, "cancelled"],
      [b.id, "pending"],
    ]);
  });

  it("only devices sent the update may download it, with a valid signature when signing is on", async () => {
    process.env.DEVICE_KEY_SECRET = "secret";
    const r = await upload("vs-1.1.0");
    await queueUpdate(db, r.id, ["DEV1"], "craig", t0);
    const sig = downloadSignature(deviceKey("DEV1")!, "DEV1", r.id);
    expect(await authorizeDownload(db, r.id, "DEV1", sig)).toMatchObject({ id: r.id });
    expect(await authorizeDownload(db, r.id, "DEV1", "0000000000000000")).toBeNull();
    expect(await authorizeDownload(db, r.id, "DEV2", downloadSignature(deviceKey("DEV2")!, "DEV2", r.id))).toBeNull();
    await cancelUpdates(db, r.id);
    expect(await authorizeDownload(db, r.id, "DEV1", sig)).toBeNull();
  });

  it("a successful answer records the new version; the release page shows progress", async () => {
    const r = await upload("vs-1.1.0");
    await queueUpdate(db, r.id, ["DEV1", "DEV2"], "craig", t0);
    await commandsForReply(db, "DEV1", t0);
    const [c1, c2] = await db.select().from(deviceCommands).orderBy(deviceCommands.id);
    await afterUpdateAnswer(db, await recordAnswer(db, "DEV1", { id: c1.id, ok: true, result: "running vs-1.1.0", sig: null }));
    await afterUpdateAnswer(db, await recordAnswer(db, "DEV2", { id: c2.id, ok: false, result: "SHA-256 mismatch", sig: null }));
    const [d1] = await db.select().from(devices).where(eq(devices.id, "DEV1"));
    expect(d1.firmwareVersion).toBe("vs-1.1.0");
    const rollout = await releaseRollout(db, r.id);
    expect(rollout!.devices.map((d) => [d.id, d.update?.state ?? null])).toEqual([
      ["DEV1", "done"],
      ["DEV2", "failed"],
      ["DEV3", null],
    ]);
    const [summary] = await listReleases(db);
    expect(summary).toMatchObject({ running: 2, updates: { done: 1, waiting: 0, failed: 1 } });
  });

  it("retired releases can't be sent or downloaded", async () => {
    const r = await upload("vs-1.1.0");
    await queueUpdate(db, r.id, ["DEV1"], "craig", t0);
    await retireRelease(db, r.id);
    await expect(queueUpdate(db, r.id, ["DEV2"], "craig", t0)).rejects.toThrow(/retired/);
    expect(await authorizeDownload(db, r.id, "DEV1", "-")).toBeNull();
    const [cmd] = await db.select().from(deviceCommands);
    expect(cmd.status).toBe("cancelled");
  });
});

describe("downloading in pieces", () => {
  it("reads Range headers and offset/length on the URL", () => {
    expect(byteRange(1000, null, null, null)).toBeNull();
    expect(byteRange(1000, "bytes=0-99", null, null)).toEqual({ start: 0, end: 99 });
    expect(byteRange(1000, "bytes=900-", null, null)).toEqual({ start: 900, end: 999 });
    expect(byteRange(1000, "bytes=950-2000", null, null)).toEqual({ start: 950, end: 999 }); // last piece is shorter
    expect(byteRange(1000, "bytes=-100", null, null)).toEqual({ start: 900, end: 999 });
    expect(byteRange(1000, null, "16", "8")).toEqual({ start: 16, end: 23 });
    expect(byteRange(1000, "bytes=0-99", "500", "10")).toEqual({ start: 500, end: 509 }); // URL wins
    for (const bad of ["bytes=1000-", "bytes=5-2", "bytes=-", "items=0-5", "bytes=0-5,10-20"]) expect(byteRange(1000, bad, null, null)).toBe("invalid");
    expect(byteRange(1000, null, "-1", "5")).toBe("invalid");
    expect(byteRange(1000, null, "0", "0")).toBe("invalid");
  });
});

describe("reported versions", () => {
  it("records FW= and ignores junk", async () => {
    await noteFirmwareVersion(db, "DEV1", "vs-1.0.0", t0);
    await noteFirmwareVersion(db, "DEV1", "<script>", t0);
    await noteFirmwareVersion(db, "DEV1", "", t0);
    const [d] = await db.select().from(devices).where(eq(devices.id, "DEV1"));
    expect(d).toMatchObject({ firmwareVersion: "vs-1.0.0", firmwareReportedAt: t0 });
  });
});
