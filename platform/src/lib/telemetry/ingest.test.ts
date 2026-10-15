import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceEvents, devices, engineSessions, telemetry } from "@/lib/db/schema";
import { ingestSamples, recordEvent, UnknownDeviceError } from "./ingest";

let db: Db;

beforeEach(async () => {
  db = createDb(); // in-memory database
  await migrateDb(db, false);
});

describe("ingestSamples", () => {
  it("registers a new device and stores its position", async () => {
    const count = await ingestSamples(db, "DEV00001", [
      { deviceMs: 1000, lat: 43.65, lng: -79.38, speedKph: 10, batteryCentivolts: 1290, rssi: -70 },
    ]);
    expect(count).toBe(1);

    const [device] = await db.select().from(devices);
    expect(device).toMatchObject({ id: "DEV00001", tier: "gps", lastLat: 43.65, lastLng: -79.38, lastRssi: -70 });
    expect(device.lastBatteryV).toBeCloseTo(12.9);
    expect(device.lastFixAt).not.toBeNull();
  });

  it("keeps the last known position when a sample has no GPS fix", async () => {
    await ingestSamples(db, "DEV00001", [{ deviceMs: 1, lat: 43.65, lng: -79.38 }]);
    await ingestSamples(db, "DEV00001", [{ deviceMs: 2, batteryCentivolts: 1250 }]);

    const [device] = await db.select().from(devices);
    expect(device.lastLat).toBe(43.65);
    expect(device.lastBatteryV).toBeCloseTo(12.5);
    expect(await db.select().from(telemetry)).toHaveLength(2);
  });

  it("ignores 0,0 positions (no GPS fix yet)", async () => {
    await ingestSamples(db, "DEV00001", [{ deviceMs: 1, lat: 0, lng: 0 }]);
    const [device] = await db.select().from(devices);
    expect(device.lastLat).toBeNull();
  });

  it("rejects unknown devices when auto-register is off", async () => {
    await expect(ingestSamples(db, "STRANGER", [{ deviceMs: 1 }], { autoRegister: false })).rejects.toBeInstanceOf(
      UnknownDeviceError,
    );
    expect(await db.select().from(devices)).toHaveLength(0);
  });
});

describe("recordEvent", () => {
  it("logs a login with signal strength and VIN", async () => {
    await recordEvent(db, "DEV00001", { type: "login", rssi: -65, vin: "1FTFW1ET5DFC10312" });
    const [device] = await db.select().from(devices);
    expect(device).toMatchObject({ lastRssi: -65, vin: "1FTFW1ET5DFC10312" });
    const [event] = await db.select().from(deviceEvents);
    expect(event.type).toBe("login");
  });
});

describe("engine sessions", () => {
  const at = (min: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + min * 60_000);
  const on = { batteryCentivolts: 1400 };
  const off = { batteryCentivolts: 1250 };

  it("opens a session when the engine starts and closes it when it stops", async () => {
    await ingestSamples(db, "DEV1", [off], { now: at(0) });
    await ingestSamples(db, "DEV1", [on], { now: at(1) });
    await ingestSamples(db, "DEV1", [on], { now: at(5) });

    let [device] = await db.select().from(devices);
    expect(device.engineOn).toBe(true);
    expect(device.engineChangedAt).toEqual(at(1));

    await ingestSamples(db, "DEV1", [off], { now: at(9) });
    const sessions = await db.select().from(engineSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ startedAt: at(1), endedAt: at(9), source: "voltage" });

    [device] = await db.select().from(devices);
    expect(device.engineOn).toBe(false);
    expect(device.engineChangedAt).toEqual(at(9));
  });

  it("closes a session at the last report when the device went silent", async () => {
    await ingestSamples(db, "DEV1", [on], { now: at(0) });
    await ingestSamples(db, "DEV1", [on], { now: at(4) });
    // 2 hours of silence, then the engine is running again
    await ingestSamples(db, "DEV1", [on], { now: at(124) });

    const sessions = await db.select().from(engineSessions).orderBy(engineSessions.startedAt);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ startedAt: at(0), endedAt: at(4) });
    expect(sessions[1]).toMatchObject({ startedAt: at(124), endedAt: null });
    const [device] = await db.select().from(devices);
    expect(device.engineChangedAt).toEqual(at(124));
  });

  it("stores the engine state on each reading and leaves state alone when unknown", async () => {
    await ingestSamples(db, "DEV1", [on], { now: at(0) });
    await ingestSamples(db, "DEV1", [{ lat: 43.6, lng: -79.4 }], { now: at(1) });
    const rows = await db.select().from(telemetry).orderBy(telemetry.id);
    expect(rows.map((r) => r.engineOn)).toEqual([true, null]);
    const [device] = await db.select().from(devices);
    expect(device.engineOn).toBe(true);
  });
});
