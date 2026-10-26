import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, deviceEvents, deviceIncidents, devices, notificationEvents, organizations } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { ingestSamples, recordEvent } from "@/lib/telemetry/ingest";
import { notifyIncidents, scoreSilence, watchdog, type SilenceInput } from "./tamper";

let db: Db;
let machineId: number;
/** 10:00 on a Wednesday in Toronto (October = UTC-4). */
const t0 = new Date("2026-10-14T14:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const running = { batteryCentivolts: 1390, rssi: -70, lat: 43.65, lng: -79.38 };
const incidents = () => db.select().from(deviceIncidents).orderBy(deviceIncidents.id);

beforeEach(async () => {
  vi.stubEnv("APP_TIMEZONE", "America/Toronto");
  db = createDb();
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Excavator", unitNumber: "14" }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

afterEach(() => vi.unstubAllEnvs());

describe("scoring a quiet device", () => {
  const base: SilenceInput = {
    now: at(30),
    lastContactAt: at(0),
    engineWasOn: true,
    signedOff: false,
    lastRssi: -70,
    lastBatteryV: 13.9,
    knownGaps: 0,
    armed: false,
    timeZone: "America/Toronto",
  };

  it("is high when it stops mid-stream with good signal and battery (like being unplugged)", () => {
    expect(scoreSilence({ ...base, now: at(9) })).toBeNull();
    const s = scoreSilence(base)!;
    expect(s.concern).toBe("high");
    expect(s.reasons).toEqual([
      "Stopped reporting at 10:00 AM while the engine was running, without signing off (like being unplugged)",
      "Signal was good (-70 dBm)",
      "Battery was healthy (13.9 V)",
    ]);
  });

  it("counts missed 15-minute check-ins after a normal sleep", () => {
    const asleep = { ...base, signedOff: true, engineWasOn: false };
    expect(scoreSilence({ ...asleep, now: at(19) })).toBeNull();
    expect(scoreSilence({ ...asleep, now: at(21) })!.concern).toBe("medium");
    expect(scoreSilence({ ...asleep, now: at(36) })).toMatchObject({ concern: "high" });
  });

  it("is less worried by weak signal, a low battery or a known dead spot, and more by an armed machine after hours", () => {
    expect(scoreSilence({ ...base, lastRssi: -105 })!.concern).toBe("medium");
    expect(scoreSilence({ ...base, lastRssi: -105, lastBatteryV: 11.2 })!.concern).toBe("low");
    expect(scoreSilence({ ...base, lastRssi: -105, lastBatteryV: 11.2, knownGaps: 2 })!.concern).toBe("low");
    expect(scoreSilence({ ...base, knownGaps: 1 })!.reasons).toContain("Has gone quiet near here 1 time before and come back by itself");
    // A device on USB (Y5725A32 on a desk read 3.65 V) isn't on the machine's battery: no "may have run flat".
    expect(scoreSilence({ ...base, lastBatteryV: 3.65 })).toMatchObject({
      concern: "high",
      reasons: expect.arrayContaining(["Was not on machine power (3.6 V: USB or a bench supply)"]),
    });
    const night = new Date("2026-10-15T06:00:00Z"); // 2 AM Toronto
    const quietAtNight = { ...base, lastContactAt: night, now: new Date(night.getTime() + 30 * 60_000), lastRssi: -105 };
    expect(scoreSilence(quietAtNight)!.concern).toBe("medium");
    expect(scoreSilence({ ...quietAtNight, armed: true })).toMatchObject({ concern: "high", reasons: expect.arrayContaining(["Armed machine, after hours"]) });
  });
});

describe("watchdog", () => {
  it("opens a high-concern incident when a running machine's device goes quiet, and closes it when it's back", async () => {
    await ingestSamples(db, "DEV1", [running], { now: at(0) });
    expect(await watchdog(db, at(5))).toEqual({ checked: 1, changed: 0 });
    expect(await watchdog(db, at(11))).toEqual({ checked: 1, changed: 1 });
    const [incident] = await incidents();
    expect(incident).toMatchObject({ kind: "silent", concern: "high", lastRssi: -70, engineWasOn: true, signedOff: false, resolvedAt: null });

    const [alert] = await notifyIncidents(db, {}, at(11));
    expect(alert).toMatchObject({ type: "tamper", title: "Possible tamper (high concern): Unit 14 · Excavator", incidentId: incident.id });
    expect(alert.detail).toContain("Went quiet. Stopped reporting at 10:00 AM while the engine was running");
    expect(await notifyIncidents(db, {}, at(16))).toEqual([]); // no repeat
    await watchdog(db, at(16));
    expect(await incidents()).toHaveLength(1);

    // Back 40 minutes later, 2 km away: the quiet spell closes and a "moved while quiet" incident opens.
    await ingestSamples(db, "DEV1", [{ ...running, lat: 43.668, lng: -79.38 }], { now: at(40) });
    const all = await incidents();
    expect(all.map((i) => [i.kind, i.concern, i.resolvedAt !== null])).toEqual([
      ["silent", "high", true],
      ["moved-while-silent", "high", true],
    ]);
    expect(all[0].resolution).toBe("Back online after 40 min quiet.");
    expect(all[1].reasons[0]).toMatch(/^Came back 2\.0 km from where it went quiet/);
    expect((await notifyIncidents(db, { machineId }, at(40))).map((a) => a.title)).toEqual(["Possible tamper (high concern): Unit 14 · Excavator"]);
    const events = await db.select().from(notificationEvents).orderBy(notificationEvents.id);
    // The engine period that was cut off ends at the last report, and a new one starts on return.
    expect(events.map((e) => e.type)).toEqual(["start", "equipment_offline", "stop", "start", "equipment_offline"]);
    expect(events[4].detail).toContain("is back online");
  });

  it("escalates from medium to high as 15-minute check-ins are missed after a normal sleep", async () => {
    await ingestSamples(db, "DEV1", [{ ...running, batteryCentivolts: 1260 }], { now: at(0) });
    await recordEvent(db, "DEV1", { type: "logout" }, { now: at(3) });
    await watchdog(db, at(15));
    expect(await incidents()).toEqual([]);
    await watchdog(db, at(24));
    expect((await incidents())[0]).toMatchObject({ concern: "medium", signedOff: true });
    expect((await notifyIncidents(db, {}, at(24))).map((a) => a.type)).toEqual(["tamper"]);
    await watchdog(db, at(39));
    expect((await incidents())[0].concern).toBe("high");
    expect((await notifyIncidents(db, {}, at(39))).map((a) => a.type)).toEqual(["tamper-escalated"]);
    expect(await db.select().from(alerts)).toHaveLength(2);
  });

  it("doesn't alert for low concern, but still reports the connectivity change", async () => {
    await ingestSamples(db, "DEV1", [{ ...running, rssi: -108, batteryCentivolts: 1120 }], { now: at(0) });
    await watchdog(db, at(12));
    expect((await incidents())[0].concern).toBe("low");
    expect(await notifyIncidents(db, {}, at(12))).toEqual([]);
    expect((await db.select().from(notificationEvents).where(eq(notificationEvents.type, "equipment_offline"))).length).toBe(1);
  });

  it("is less worried where the device has dropped out before and come back by itself", async () => {
    await ingestSamples(db, "DEV1", [running], { now: at(0) });
    await watchdog(db, at(12));
    await ingestSamples(db, "DEV1", [running], { now: at(20) }); // back, same place
    await watchdog(db, at(32));
    const [, second] = await incidents();
    expect(second).toMatchObject({ concern: "medium" });
    expect(second.reasons).toContain("Has gone quiet near here 1 time before and come back by itself");
  });

  it("ignores devices that aren't on a machine", async () => {
    await db.insert(devices).values({ id: "SPARE", lastSeenAt: at(-500) });
    expect(await watchdog(db, at(0))).toMatchObject({ checked: 1 });
    expect(await incidents()).toEqual([]);
  });
});

describe("when the device comes back", () => {
  it("flags a different vehicle (VIN)", async () => {
    await recordEvent(db, "DEV1", { type: "login", vin: "1FTFW1ET5DFC10312" }, { now: at(0) });
    await recordEvent(db, "DEV1", { type: "login", vin: "1FTFW1ET5DFC10312" }, { now: at(1) });
    expect(await incidents()).toEqual([]);
    await recordEvent(db, "DEV1", { type: "logout" }, { now: at(2) });
    await recordEvent(db, "DEV1", { type: "login", vin: "2HGFC2F59JH512345" }, { now: at(60) });
    const [incident] = await incidents();
    expect(incident).toMatchObject({ kind: "vin-changed", concern: "high" });
    expect(incident.reasons[0]).toContain("now reports vehicle 2HGFC2F59JH512345; before it was 1FTFW1ET5DFC10312");
  });

  it("flags a restart without signing off (power interrupted), but not a normal wake-up", async () => {
    await ingestSamples(db, "DEV1", [running], { now: at(0) });
    await recordEvent(db, "DEV1", { type: "logout" }, { now: at(3) });
    await recordEvent(db, "DEV1", { type: "login" }, { now: at(18) }); // 15-minute check-in after sleeping
    expect(await incidents()).toEqual([]);

    await ingestSamples(db, "DEV1", [running], { now: at(30) });
    await recordEvent(db, "DEV1", { type: "login" }, { now: at(34) }); // unplugged for ~4 minutes, plugged back in
    const [incident] = await incidents();
    expect(incident).toMatchObject({ kind: "power-interrupted", concern: "medium" });
    expect(incident.reasons[0]).toContain("Restarted at 10:34 AM without signing off, after 4 min without contact");
  });

  it("uses our firmware's restart reason: a crash is low concern (no alert), low voltage stays medium", async () => {
    await recordEvent(db, "DEV1", { type: "login" }, { now: at(-1) });
    await ingestSamples(db, "DEV1", [running], { now: at(0) });
    await recordEvent(db, "DEV1", { type: "login", restart: { reason: "panic", boot: 41 } }, { now: at(4) });
    await ingestSamples(db, "DEV1", [running], { now: at(10) });
    await recordEvent(db, "DEV1", { type: "login", restart: { reason: "brownout", boot: 42 } }, { now: at(14) });
    const [crash, brownout] = await incidents();
    expect(crash).toMatchObject({ kind: "device-restart", concern: "low" });
    expect(crash.reasons[0]).toContain("crashed (software fault). Not a power cut");
    expect(brownout).toMatchObject({ kind: "power-interrupted", concern: "medium" });
    expect(brownout.reasons[0]).toContain("supply voltage dropped too low");
    const [, event] = await db.select().from(deviceEvents).where(eq(deviceEvents.type, "login")).orderBy(deviceEvents.at);
    expect(event.detail).toBe("Restarted: Crashed (software fault) (start-up #41)");
  });
});
