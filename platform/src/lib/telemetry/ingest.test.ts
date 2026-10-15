import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceEvents, devices, telemetry } from "@/lib/db/schema";
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
