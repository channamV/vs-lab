import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceCommands, devices } from "@/lib/db/schema";
import { ackSignature, cancelCommand, commandHistory, commandsForReply, deviceKey, queueCommand, recordAnswer, withCommands } from "./commands";

let db: Db;
const t0 = new Date("2026-10-21T15:00:00Z");
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const history = () => db.select().from(deviceCommands).orderBy(deviceCommands.id);

beforeEach(async () => {
  vi.stubEnv("DEVICE_KEY_SECRET", "test-secret");
  db = createDb();
  await migrateDb(db, false);
  await db.insert(devices).values({ id: "DEV1" });
});
afterEach(() => vi.unstubAllEnvs());

describe("device commands", () => {
  it("validates commands and describes them in plain words", async () => {
    await expect(queueCommand(db, "DEV1", "selfdestruct", {}, "s@v.ca")).rejects.toThrow(/Unknown command/);
    await expect(queueCommand(db, "NOPE", "report", {}, "s@v.ca")).rejects.toThrow(/Device not found/);
    await expect(queueCommand(db, "DEV1", "rate", { seconds: "0" }, "s@v.ca")).rejects.toThrow(/Check the values/);
    const c = await queueCommand(db, "DEV1", "buzzer", { times: "2" }, "s@v.ca", t0);
    expect(c).toMatchObject({ command: "BEEP=2", label: "Sound the buzzer 2 times", status: "pending", expiresAt: at(24 * 3600) });
  });

  it("goes out signed in the reply, is resent until answered, and records the signed answer", async () => {
    const c = await queueCommand(db, "DEV1", "rate", { seconds: "10" }, "s@v.ca", t0);
    const key = deviceKey("DEV1")!;
    expect(key).toBe(createHmac("sha256", "test-secret").update("device-key:DEV1").digest("hex").slice(0, 32));
    const sig = createHmac("sha256", key).update(`DEV1\n${c.id}\nRATE=10`).digest("hex").slice(0, 16);
    const lines = await commandsForReply(db, "DEV1", at(1));
    expect(lines).toEqual([`CMD ${c.id} ${sig} RATE=10`]);
    expect(withCommands("OK 1", lines)).toBe(`OK 1\nCMD ${c.id} ${sig} RATE=10`);
    expect(await commandsForReply(db, "DEV1", at(30))).toEqual([]); // just sent: not again yet
    expect(await commandsForReply(db, "DEV1", at(70))).toHaveLength(1); // unanswered after a minute: resent
    expect((await history())[0]).toMatchObject({ status: "sent", sendCount: 2, sentAt: at(70) });

    // Answers must be signed with the device's key.
    await expect(recordAnswer(db, "DEV1", { id: c.id, ok: true, result: "every 10 s", sig: "0000000000000000" }, at(80))).rejects.toThrow(/Bad signature/);
    await recordAnswer(db, "DEV1", { id: c.id, ok: true, result: "every 10 s", sig: ackSignature(key, "DEV1", c.id, true, "every 10 s") }, at(80));
    expect((await history())[0]).toMatchObject({ status: "done", result: "every 10 s", answeredAt: at(80) });
    expect(await commandsForReply(db, "DEV1", at(200))).toEqual([]);
    // Another device can't answer for it.
    await expect(recordAnswer(db, "DEV2", { id: c.id, ok: true, result: "", sig: ackSignature(deviceKey("DEV2")!, "DEV2", c.id, true, "") })).rejects.toThrow(/Unknown command/);
  });

  it("expires commands that get no answer, and can be cancelled", async () => {
    await queueCommand(db, "DEV1", "report", {}, "s@v.ca", t0);
    for (let i = 0; i < 5; i++) await commandsForReply(db, "DEV1", at(i * 61));
    expect((await history())[0]).toMatchObject({ sendCount: 5, status: "sent" });
    // Sent 5 times with no answer: given up a minute after the last try.
    expect(await commandsForReply(db, "DEV1", at(5 * 61))).toEqual([]);
    expect((await commandHistory(db, "DEV1"))[0].status).toBe("expired");

    const old = await queueCommand(db, "DEV1", "report", {}, "s@v.ca", t0);
    expect(await commandsForReply(db, "DEV1", at(25 * 3600))).toEqual([]); // a day later: too late
    expect((await history()).find((c) => c.id === old.id)?.status).toBe("expired");

    const c = await queueCommand(db, "DEV1", "restart", {}, "s@v.ca", t0);
    await cancelCommand(db, "DEV1", c.id);
    expect(await commandsForReply(db, "DEV1", at(10))).toEqual([]);
  });

  it("doesn't keep Wi-Fi passwords once a command is finished", async () => {
    const c = await queueCommand(db, "DEV1", "wifi", { ssid: "Site 4 Starlink", password: "hunter22" }, "s@v.ca", t0);
    expect(c).toMatchObject({ command: "WIFI=Site 4 Starlink\thunter22", label: 'Set Wi-Fi to "Site 4 Starlink"' });
    const [line] = await commandsForReply(db, "DEV1", at(1));
    expect(line).toMatch(/^CMD \d+ [0-9a-f]{16} WIFI=Site 4 Starlink\thunter22$/);
    const key = deviceKey("DEV1")!;
    await recordAnswer(db, "DEV1", { id: c.id, ok: true, result: "saved", sig: ackSignature(key, "DEV1", c.id, true, "saved") });
    expect((await history())[0].command).toBe("WIFI=Site 4 Starlink\t(password removed)");
  });

  it("sends unsigned commands and accepts unsigned answers only when signing isn't set up", async () => {
    vi.stubEnv("DEVICE_KEY_SECRET", "");
    expect(deviceKey("DEV1")).toBeNull();
    const c = await queueCommand(db, "DEV1", "report", {}, "s@v.ca", t0);
    expect(await commandsForReply(db, "DEV1", at(1))).toEqual([`CMD ${c.id} - REPORT`]);
    await recordAnswer(db, "DEV1", { id: c.id, ok: false, result: "busy", sig: null });
    expect((await history())[0]).toMatchObject({ status: "failed", result: "busy" });
  });
});
