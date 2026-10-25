import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { eq } from "drizzle-orm";
import { deviceEvents, devices, engineSessions, machines, organizations, telemetry } from "@/lib/db/schema";
import { parsePayload } from "@/lib/freematics/protocol";
import { createMachine, pairDevice, unpairDevice } from "@/lib/machines";
import { engineStatus } from "./engine";
import { endQuietEngineSessions, ingestSamples, recordEvent, UnknownDeviceError } from "./ingest";

let db: Db;
let machineId: number;

beforeEach(async () => {
  db = createDb(); // in-memory database
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC Civil" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Excavator", unitNumber: "14" }));
});

/** Registers a device and puts it on the test machine. */
async function paired(deviceId: string, now?: Date) {
  await db.insert(devices).values({ id: deviceId }).onConflictDoNothing();
  await pairDevice(db, deviceId, machineId, now);
}

const getMachine = async () => (await db.select().from(machines).where(eq(machines.id, machineId)))[0];

describe("engine off when the device sleeps", () => {
  const t0 = new Date("2026-10-25T15:50:00Z");
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const running = (ms: number) => [{ deviceMs: ms, batteryCentivolts: 1420 }];

  it("ends the engine-on period at the last running reading when the device signs off", async () => {
    await paired("DEV00001");
    await ingestSamples(db, "DEV00001", running(1000), { now: at(0) });
    await ingestSamples(db, "DEV00001", running(181_000), { now: at(3) });
    await recordEvent(db, "DEV00001", { type: "logout" }, { now: at(4) });
    const [session] = await db.select().from(engineSessions);
    expect(session.endedAt).toEqual(at(3));
    expect(await getMachine()).toMatchObject({ engineOn: false, engineChangedAt: at(3) });
  });

  it("ends one that pings keep alive but nothing confirms, after the stale time", async () => {
    await paired("DEV00001");
    await ingestSamples(db, "DEV00001", running(1000), { now: at(0) });
    await recordEvent(db, "DEV00001", { type: "ping" }, { now: at(5) });
    expect((await getMachine()).engineOn).toBe(true); // too soon to tell
    await recordEvent(db, "DEV00001", { type: "ping" }, { now: at(15) });
    expect((await getMachine()).engineOn).toBe(false);
    expect((await db.select().from(engineSessions))[0].endedAt).toEqual(at(0));
  });

  it("is also done by the watchdog for every machine, and leaves confirmed ones alone", async () => {
    await paired("DEV00001");
    await ingestSamples(db, "DEV00001", running(1000), { now: at(0) });
    expect(await endQuietEngineSessions(db, at(9))).toEqual([]);
    expect(await endQuietEngineSessions(db, at(11))).toEqual([machineId]);
    expect(await endQuietEngineSessions(db, at(12))).toEqual([]);
  });

  it("doesn't let an old reading in an upload restart the engine", async () => {
    await paired("DEV00001");
    const now = new Date("2026-10-25T16:10:00Z");
    // Parked readings now, plus a running one from 8 minutes ago (a backlog), all in one upload.
    await ingestSamples(
      db,
      "DEV00001",
      [
        { deviceMs: 900_000, gpsTime: 16095500, lat: 47.5, lng: -52.8, batteryCentivolts: 1265 },
        { deviceMs: 420_000, gpsTime: 16020000, lat: 47.4, lng: -52.9, batteryCentivolts: 1410 },
      ],
      { now },
    );
    expect(await db.select().from(engineSessions)).toHaveLength(0);
    expect((await getMachine()).engineOn).toBe(false);
  });
});

describe("late readings (backlog sent after newer ones)", () => {
  it("dates readings by GPS time, keeps the parked position current, and orders the track by when it happened", async () => {
    await paired("DEV00001");
    const now = new Date("2026-10-25T14:53:20Z");
    // Parked: the live reading arrives first...
    await ingestSamples(db, "DEV00001", [{ deviceMs: 900_000, gpsTime: 14531500, lat: 47.52, lng: -52.8, speedKph: 0 }], { now });
    // ...then a backlog from the drive, newest first (Telelogger's order), arriving a few seconds later.
    const later = new Date(now.getTime() + 5000);
    await ingestSamples(
      db,
      "DEV00001",
      [
        { deviceMs: 420_000, gpsTime: 14450000, lat: 47.51, lng: -52.82, speedKph: 50, j1939Rpm: 1500 },
        { deviceMs: 360_000, gpsTime: 14440000, lat: 47.5, lng: -52.84, speedKph: 50, j1939Rpm: 1500 },
      ],
      { now: later },
    );
    const machine = await getMachine();
    expect([machine.lastLat, machine.lastLng]).toEqual([47.52, -52.8]); // still where it's parked
    expect(await db.select().from(engineSessions)).toHaveLength(0); // old "running" readings don't start the engine now
    const rows = await db.select().from(telemetry).orderBy(telemetry.recordedAt);
    expect(rows.map((r) => [r.recordedAt.toISOString(), r.lat])).toEqual([
      ["2026-10-25T14:44:00.000Z", 47.5],
      ["2026-10-25T14:45:00.000Z", 47.51],
      ["2026-10-25T14:53:15.000Z", 47.52],
    ]);
  });
});

describe("ingestSamples", () => {
  it("registers a new device and stores its position", async () => {
    const count = await ingestSamples(db, "DEV00001", [
      { deviceMs: 1000, lat: 43.65, lng: -79.38, speedKph: 10, batteryCentivolts: 1290, rssi: -70 },
    ]);
    expect(count).toBe(1);

    const [device] = await db.select().from(devices);
    expect(device).toMatchObject({ id: "DEV00001", organizationId: null, lastLat: 43.65, lastLng: -79.38, lastRssi: -70 });
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

describe("machines and devices", () => {
  it("leaves data from an unpaired device without a machine (bench test, in stock)", async () => {
    await ingestSamples(db, "DEV1", [{ deviceMs: 1, lat: 43.65, lng: -79.38, batteryCentivolts: 1400 }]);
    const [row] = await db.select().from(telemetry);
    expect(row.machineId).toBeNull();
    expect(await db.select().from(engineSessions)).toHaveLength(0);
    expect((await getMachine()).lastSeenAt).toBeNull();
  });

  it("stamps a paired device's data with the machine and updates the machine's snapshot", async () => {
    await paired("DEV1");
    await ingestSamples(db, "DEV1", [{ deviceMs: 1, lat: 43.65, lng: -79.38, rssi: -70 }]);
    await recordEvent(db, "DEV1", { type: "ping", rssi: -60 });
    expect((await db.select().from(telemetry))[0].machineId).toBe(machineId);
    expect((await db.select().from(deviceEvents))[0].machineId).toBe(machineId);
    expect(await getMachine()).toMatchObject({ lastLat: 43.65, lastLng: -79.38, lastRssi: -60 });
  });

  it("keeps the machine's history when its device is replaced", async () => {
    const at = (min: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + min * 60_000);
    await paired("OLD", at(0));
    await ingestSamples(db, "OLD", [{ batteryCentivolts: 1400, lat: 43.6, lng: -79.4 }], { now: at(1) });
    await ingestSamples(db, "OLD", [{ batteryCentivolts: 1400 }], { now: at(3) });
    // The old device fails while the engine is running: staff unpair it and fit a new one.
    await unpairDevice(db, "OLD", at(30));
    let sessions = await db.select().from(engineSessions);
    expect(sessions).toEqual([expect.objectContaining({ machineId, startedAt: at(1), endedAt: at(3) })]);
    expect((await getMachine()).engineOn).toBeNull();

    // The old device keeps reporting from the workbench: none of it reaches the machine.
    await ingestSamples(db, "OLD", [{ batteryCentivolts: 1400, lat: 45, lng: -75 }], { now: at(40) });
    expect((await getMachine()).lastLat).toBe(43.6);

    await paired("NEW", at(50));
    await ingestSamples(db, "NEW", [{ batteryCentivolts: 1400 }], { now: at(60) });
    sessions = await db.select().from(engineSessions).orderBy(engineSessions.startedAt);
    expect(sessions.map((s) => [s.machineId, s.startedAt, s.endedAt])).toEqual([
      [machineId, at(1), at(3)],
      [machineId, at(60), null],
    ]);
    const rows = await db.select().from(telemetry).orderBy(telemetry.id);
    expect(rows.map((r) => [r.deviceId, r.machineId])).toEqual([
      ["OLD", machineId],
      ["OLD", machineId],
      ["OLD", null],
      ["NEW", machineId],
    ]);
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

  beforeEach(() => paired("DEV1"));

  it("opens a session when the engine starts and closes it when it stops", async () => {
    await ingestSamples(db, "DEV1", [off], { now: at(0) });
    await ingestSamples(db, "DEV1", [on], { now: at(1) });
    await ingestSamples(db, "DEV1", [on], { now: at(5) });

    let machine = await getMachine();
    expect(machine.engineOn).toBe(true);
    expect(machine.engineChangedAt).toEqual(at(1));
    expect((await db.select().from(devices))[0].engineOn).toBe(true);

    await ingestSamples(db, "DEV1", [off], { now: at(9) });
    const sessions = await db.select().from(engineSessions);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ startedAt: at(1), endedAt: at(9), source: "voltage" });

    machine = await getMachine();
    expect(machine.engineOn).toBe(false);
    expect(machine.engineChangedAt).toEqual(at(9));
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
    expect((await getMachine()).engineChangedAt).toEqual(at(124));
  });

  it("stores the engine state on each reading and leaves state alone when unknown", async () => {
    await ingestSamples(db, "DEV1", [on], { now: at(0) });
    await ingestSamples(db, "DEV1", [{ lat: 43.6, lng: -79.4 }], { now: at(1) });
    const rows = await db.select().from(telemetry).orderBy(telemetry.id);
    expect(rows.map((r) => r.engineOn)).toEqual([true, null]);
    expect((await getMachine()).engineOn).toBe(true);
  });

  it("doesn't count a still device as running (Telelogger sends acceleration with gravity removed)", async () => {
    // Real uploads from Y5725A32 on a desk, which used to show its machine as running.
    for (const [i, raw] of ["0:173812,81:-77,20:0;0;0,82:32*D", "0:178812,20:0;0;0,82:32*A8"].entries()) {
      await ingestSamples(db, "DEV1", parsePayload(raw).samples, { now: at(i) });
    }
    expect(await db.select().from(engineSessions)).toHaveLength(0);
    expect(await getMachine()).toMatchObject({ engineOn: false, engineChangedAt: at(0) });
  });

  it("leaves the engine state, sessions and 'since' time alone on uploads with no engine signal", async () => {
    const noSignal = { deviceMs: 5, rssi: -80 };
    await ingestSamples(db, "DEV1", [on], { now: at(0) });
    await ingestSamples(db, "DEV1", [noSignal], { now: at(2) });
    expect(await getMachine()).toMatchObject({ engineOn: true, engineChangedAt: at(0) });
    expect((await db.select().from(devices))[0].engineOn).toBe(true);
    expect(await db.select().from(engineSessions)).toEqual([
      expect.objectContaining({ startedAt: at(0), endedAt: null, lastSeenAt: at(0) }),
    ]);

    await ingestSamples(db, "DEV1", [off], { now: at(3) });
    await ingestSamples(db, "DEV1", [noSignal], { now: at(4) });
    expect(await getMachine()).toMatchObject({ engineOn: false, engineChangedAt: at(3) });
    expect(await db.select().from(engineSessions)).toEqual([expect.objectContaining({ startedAt: at(0), endedAt: at(3) })]);
  });

  it("shows the engine as unknown when uploads keep arriving with no engine signal", async () => {
    const gpsOnly = { lat: 43.6, lng: -79.4 };
    await ingestSamples(db, "DEV1", [on], { now: at(0) });
    expect((await getMachine()).engineUnknownSince).toBeNull();

    await ingestSamples(db, "DEV1", [gpsOnly], { now: at(1) });
    await ingestSamples(db, "DEV1", [gpsOnly], { now: at(6) });
    let machine = await getMachine();
    expect(machine.engineUnknownSince).toEqual(at(1)); // since the first upload without a signal
    expect(engineStatus(machine, at(6).getTime())).toBe("running");

    await ingestSamples(db, "DEV1", [gpsOnly], { now: at(12) });
    machine = await getMachine();
    expect(engineStatus(machine, at(12).getTime())).toBe("unknown");
    expect(machine.engineOn).toBe(true); // the last known state is kept, just not shown as current

    await ingestSamples(db, "DEV1", [off], { now: at(13) });
    machine = await getMachine();
    expect(machine.engineUnknownSince).toBeNull();
    expect(engineStatus(machine, at(13).getTime())).toBe("off");
  });
});
