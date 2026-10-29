import { beforeEach, describe, expect, it } from "vitest";
import { eq, gte } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, engineSessions, organizations, telemetry } from "@/lib/db/schema";
import { createMachine } from "@/lib/machines";
import { buildReport, REPORT_CSV, reportRange, toCsv } from "@/lib/reports";
import { distanceFrom, fillSessionDistances, gpsKm, type DistancePoint } from "./distance";

const T0 = Date.parse("2026-10-21T12:00:00Z");
const MIN = 60_000;
/** Heading east from (47.5, -52.7) at about 1 km a minute (0.0133° of longitude ≈ 1 km at 47.5° N). */
const east = (min: number, km: number, odometerKm: number | null = null): DistancePoint => ({ t: T0 + min * MIN, lat: 47.5, lng: -52.7 + km * 0.01331, odometerKm });

describe("distance per engine-on period (pure)", () => {
  it("uses the odometer, with GPS before its first and after its last reading", () => {
    const points = [east(0, 0), east(1, 1, 81_033.2), east(5, 5), east(10, 10, 81_042.4), east(11, 11)];
    const d = distanceFrom(points)!;
    expect(d.source).toBe("odometer");
    expect(d.km).toBeCloseTo(9.2 + 1 + 1, 1);
  });

  it("falls back to GPS without an odometer, or when the odometer can't be trusted", () => {
    expect(distanceFrom([east(0, 0), east(5, 5), east(10, 10)])).toMatchObject({ source: "gps" });
    expect(distanceFrom([east(0, 0), east(5, 5)])!.km).toBeCloseTo(5, 1);
    // Went backwards: not a real odometer reading.
    expect(distanceFrom([east(0, 0, 500), east(5, 5, 100), east(10, 10)])).toMatchObject({ source: "gps" });
    expect(distanceFrom([{ t: T0, lat: null, lng: null, odometerKm: null }])).toBeNull();
  });

  it("gives no GPS distance when the engine was only detected from vibration (could be riding on a trailer)", () => {
    expect(distanceFrom([east(0, 0), east(30, 30)], { gps: false })).toBeNull();
    // An odometer still counts: a towed machine's odometer doesn't move.
    expect(distanceFrom([east(0, 0, 100), east(30, 30, 100)], { gps: false })).toEqual({ km: 0, source: "odometer" });
  });

  it("ignores GPS jitter while parked or idling", () => {
    // An hour idling with the position wandering ±10 m every second.
    const jitter: DistancePoint[] = Array.from({ length: 3600 }, (_, i) => ({ t: T0 + i * 1000, lat: 47.5 + (i % 2 ? 0.00009 : 0), lng: -52.7, odometerKm: null }));
    expect(gpsKm(jitter)).toBe(0);
  });
});

describe("stored per period, and in Reports", () => {
  let db: Db;
  let machineId: number;
  let org: number;
  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC", timezone: "America/St_Johns" }).returning();
    ({ id: machineId } = await createMachine(db, org, { name: "CX-9", unitNumber: "7" }));
    await db.insert(devices).values({ id: "DEV1" });
  });
  const reading = (min: number, km: number, odometerKm?: number) => ({
    deviceId: "DEV1",
    machineId,
    receivedAt: new Date(T0 + min * MIN),
    recordedAt: new Date(T0 + min * MIN),
    lat: 47.5,
    lng: -52.7 + km * 0.01331,
    engineOn: true,
    fields: (odometerKm === undefined ? {} : { obdOdometerKm: odometerKm }) as Record<string, number>,
  });

  it("works out ended periods once (watchdog), and reports km per machine and per period", async () => {
    await db.insert(telemetry).values([reading(0, 0, 1000), reading(10, 10, 1010)]);
    const [trip] = await db.insert(engineSessions).values({ machineId, startedAt: new Date(T0), endedAt: new Date(T0 + 10 * MIN), lastSeenAt: new Date(T0 + 10 * MIN) }).returning();
    // Still running: worked out on the spot.
    await db.insert(engineSessions).values({ machineId, startedAt: new Date(T0 + 60 * MIN), lastSeenAt: new Date(T0 + 70 * MIN) });
    expect(await fillSessionDistances(db, new Date(T0 + 12 * MIN))).toBe(0); // not settled yet
    expect(await fillSessionDistances(db, new Date(T0 + 20 * MIN))).toBe(1);
    expect((await db.select().from(engineSessions).where(eq(engineSessions.id, trip.id)))[0]).toMatchObject({ distanceKm: 10, distanceSource: "odometer" });
    expect(await fillSessionDistances(db, new Date(T0 + 30 * MIN))).toBe(0); // done once
    // Engine "on" from vibration only, the machine on a trailer: no km.
    const [hauled] = await db
      .insert(engineSessions)
      .values({ machineId, source: "vibration", startedAt: new Date(T0 + 20 * MIN), endedAt: new Date(T0 + 50 * MIN), lastSeenAt: new Date(T0 + 50 * MIN) })
      .returning();
    await db.insert(telemetry).values([reading(20, 10), reading(50, 40)]);
    await fillSessionDistances(db, new Date(T0 + 59 * MIN));
    expect((await db.select().from(engineSessions).where(eq(engineSessions.id, hauled.id)))[0]).toMatchObject({ distanceKm: null, distanceSource: "none" });
    await db.delete(engineSessions).where(eq(engineSessions.id, hauled.id));
    await db.delete(telemetry).where(gte(telemetry.recordedAt, new Date(T0 + 20 * MIN)));
    await db.insert(telemetry).values([reading(60, 10), reading(70, 16)]);

    const now = T0 + 71 * MIN;
    const range = reportRange({ range: "today" }, now, "America/St_Johns");
    const r = await buildReport(db, { organizationId: org, divisionIds: null }, range, "America/St_Johns", { now });
    expect(r.machines[0]).toMatchObject({ distanceSource: "mixed" });
    expect(r.machines[0].distanceKm).toBeCloseTo(16, 0);
    expect(r.totals).toMatchObject({ distanceMachines: 1 });
    expect(r.sessionLog.map((s) => [s.distanceSource, Math.round(s.distanceKm ?? -1), s.running])).toEqual([
      ["odometer", 10, false],
      ["gps", 6, true],
    ]);
    const csv = toCsv(REPORT_CSV.sessions(r));
    expect(csv.split("\r\n")[0]).toBe("Started,Ended,Machine,Operator,Engine hours,Distance (km),Distance from");
    expect(csv).toContain("Unit 7 · CX-9,,0.17,10.0,odometer");
  });
});
