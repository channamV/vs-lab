import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, engineSessions, operators, organizations, telemetry } from "@/lib/db/schema";
import { createMachine } from "@/lib/machines";
import { HISTORY_RULES, locationHistory, voltageHistory } from "./history";
import { toCsv } from "./reports";
import {
  dropOutliers,
  findStops,
  historyRange,
  replayTimeline,
  replayToReal,
  splitSegments,
  stopEngineLabel,
  voltageRuns,
  type TrackPoint,
} from "./history-track";

const TZ = "America/Toronto";
const MIN = 60_000;
const T0 = Date.parse("2026-10-20T12:00:00Z");
/** Points along a line heading east from (45, -75): ~0.0013° ≈ 100 m per step. */
const pt = (min: number, east: number, extra: Partial<TrackPoint> = {}): TrackPoint => ({
  t: T0 + min * MIN,
  lat: 45,
  lng: -75 + east * 0.0013,
  kph: 20,
  heading: 90,
  engineOn: true,
  ...extra,
});

describe("historyRange", () => {
  const now = Date.parse("2026-10-25T14:30:00Z"); // 10:30 in Toronto
  it("handles presets in the company's time zone", () => {
    expect(historyRange({}, now, TZ)).toMatchObject({ preset: "24h", from: now - 24 * 60 * MIN, to: now });
    expect(historyRange({ range: "today" }, now, TZ)).toMatchObject({ from: Date.parse("2026-10-25T04:00:00Z"), to: now });
    expect(historyRange({ range: "yesterday" }, now, TZ)).toMatchObject({
      from: Date.parse("2026-10-24T04:00:00Z"),
      to: Date.parse("2026-10-25T04:00:00Z"),
    });
  });

  it("takes a custom range in local time, swapped, clipped to now and to 31 days", () => {
    const r = historyRange({ range: "custom", from: "2026-10-25T08:00", to: "2026-10-24T06:15" }, now, TZ);
    expect([r.from, r.to]).toEqual([Date.parse("2026-10-24T10:15:00Z"), Date.parse("2026-10-25T12:00:00Z")]);
    expect(r.fromInput).toBe("2026-10-24T06:15");
    expect(historyRange({ range: "custom", from: "2026-10-25T08:00", to: "2026-12-01T00:00" }, now, TZ).to).toBe(now);
    const long = historyRange({ range: "custom", from: "2026-01-01T00:00", to: "2026-10-25T00:00" }, now, TZ);
    expect(long.to - long.from).toBe(31 * 24 * 60 * MIN);
    expect(historyRange({ range: "custom", from: "garbage" }, now, TZ).preset).toBe("24h");
  });
});

describe("track helpers", () => {
  it("drops a lone GPS glitch but keeps real movement", () => {
    const track = [pt(0, 0), pt(1, 1), { ...pt(2, 2), lat: 46 }, pt(3, 3), pt(4, 4)];
    expect(dropOutliers(track).map((p) => p.t)).toEqual([0, 1, 3, 4].map((m) => T0 + m * MIN));
  });

  it("breaks the line where the device was quiet and the machine reappeared elsewhere", () => {
    const track = [pt(0, 0), pt(1, 1), pt(40, 30), pt(41, 31), pt(80, 31.1)];
    // 40-minute gap + 3 km jump → break; the quiet hour at the same place doesn't break it.
    expect(splitSegments(track).map((s) => s.length)).toEqual([2, 3]);
  });

  it("finds stops: parked with the device asleep, and idling with the engine on", () => {
    const track = [
      pt(0, 0),
      pt(1, 1, { kph: 0, engineOn: false }), // parks
      pt(61, 1.2, { kph: 0, engineOn: false }), // wakes an hour later, 26 m away
      pt(62, 5),
      pt(63, 6, { kph: 0 }), // idles 8 min with the engine running
      pt(71, 6, { kph: 0 }),
      pt(72, 9),
    ];
    const stops = findStops(track);
    expect(stops.map((s) => [s.minutes, s.engineMinutes, s.idleMinutes, stopEngineLabel(s)])).toEqual([
      [60, 0, 0, "Engine off"],
      [8, 5, 5, "Idled 5 min"], // an 8-minute gap between readings counts as 5 (device may have slept)
    ]);
  });

  it("labels a stop by what the engine did most of the time", () => {
    expect(stopEngineLabel({ minutes: 960, engineMinutes: 6, idleMinutes: 2 })).toBe("Engine off · idled 2 min");
    expect(stopEngineLabel({ minutes: 400, engineMinutes: 400, idleMinutes: 45 })).toBe("Idled 45 min");
    expect(stopEngineLabel({ minutes: 13, engineMinutes: 13, idleMinutes: 0 })).toBe("Engine running");
  });

  it("replays quiet periods quickly when asked", () => {
    const track = [{ t: 0 }, { t: 10_000 }, { t: 3_600_000 }, { t: 3_610_000 }];
    expect(replayTimeline(track, false)).toEqual([0, 10_000, 3_600_000, 3_610_000]);
    const skip = replayTimeline(track, true);
    expect(skip).toEqual([0, 10_000, 70_000, 80_000]);
    expect(replayToReal(track, skip, 40_000)).toBe(10_000 + 0.5 * 3_590_000);
    expect(replayToReal(track, skip, 999_999)).toBe(3_610_000);
  });

  it("breaks the voltage line where readings are missing", () => {
    const v = (min: number) => ({ t: min * MIN, min: 12, max: 12, avg: 12, n: 1, engineOn: false });
    expect(voltageRuns([v(0), v(1), v(2), v(10), v(11)], MIN).map((r) => r.length)).toEqual([3, 2]);
  });
});

describe("database history", () => {
  let db: Db;
  let machineId: number;
  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    const [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
    ({ id: machineId } = await createMachine(db, org, { name: "Loader" }));
    await db.insert(devices).values({ id: "DEV1", organizationId: org });
    const [op] = await db.insert(operators).values({ organizationId: org, name: "Jane", pinHash: "x" }).returning();
    await db.insert(checkins).values({ organizationId: org, machineId, operatorId: op.id, startedAt: new Date(T0), endedAt: new Date(T0 + 30 * MIN), authorized: true, checklistOk: true, answers: [] });
  });
  const row = (min: number, extra: Partial<typeof telemetry.$inferInsert> = {}) => ({
    deviceId: "DEV1",
    machineId,
    receivedAt: new Date(T0 + min * MIN),
    recordedAt: new Date(T0 + min * MIN),
    fields: {},
    ...extra,
  });

  it("summarises voltage per time slice, keeping the lowest reading, with engine periods", async () => {
    await db.insert(telemetry).values([
      row(0, { batteryV: 12.6, engineOn: false }),
      row(1, { batteryV: 9.8, engineOn: false }), // cranking dip
      row(2, { batteryV: 14.2, engineOn: true }),
      row(3, { batteryV: 14.1, engineOn: true }),
      row(4, { batteryV: null }),
    ]);
    await db.insert(engineSessions).values({ machineId, startedAt: new Date(T0 + 2 * MIN), endedAt: new Date(T0 + 4 * MIN), lastSeenAt: new Date(T0 + 4 * MIN) });
    const h = await voltageHistory(db, machineId, T0 - 10 * MIN, T0 + 290 * MIN, T0 + 300 * MIN);
    expect(h.bucketSeconds).toBe(60);
    expect(h.points.map((p) => [p.min, p.engineOn])).toEqual([
      [12.6, false],
      [9.8, false],
      [14.2, true],
      [14.1, true],
    ]);
    expect(h.summary).toMatchObject({ readings: 4, min: 9.8, max: 14.2, latest: { v: 14.1, at: T0 + 3 * MIN }, system: 12, lowThreshold: 11.9 });
    expect(h.engine).toEqual([{ from: T0 + 2 * MIN, to: T0 + 4 * MIN }]);
  });

  it("returns the track with stops and operators, thinning long histories", async () => {
    await db.insert(telemetry).values([
      row(0, { lat: 45, lng: -75, speedKph: 20 }),
      row(1, { lat: 45, lng: -74.998, speedKph: 30 }),
      row(2, { lat: 0, lng: 0 }), // no fix
      row(20, { lat: 45, lng: -74.998, speedKph: 0 }),
      row(21, { lat: 45, lng: -74.99, speedKph: 40 }),
    ]);
    const h = await locationHistory(db, machineId, T0 - MIN, T0 + 60 * MIN, T0 + 60 * MIN);
    expect(h.points).toHaveLength(4);
    expect(h.stops.map((s) => s.minutes)).toEqual([19]);
    expect(h.operators).toEqual([{ name: "Jane", from: T0, to: T0 + 30 * MIN }]);
    expect(h.summary).toMatchObject({ positions: 4, thinnedToSeconds: null, maxKph: 40 });
    expect(h.summary.distanceKm).toBeGreaterThan(0.7);

    const many = Array.from({ length: HISTORY_RULES.maxTrackPoints + 100 }, (_, i) => ({
      deviceId: "DEV1",
      machineId,
      receivedAt: new Date(T0 + 2 * 60 * MIN + i * 1000),
      recordedAt: new Date(T0 + 2 * 60 * MIN + i * 1000),
      fields: {},
      lat: 45,
      lng: -75 + i * 0.00001,
    }));
    for (let i = 0; i < many.length; i += 1000) await db.insert(telemetry).values(many.slice(i, i + 1000));
    const thin = await locationHistory(db, machineId, T0 + 2 * 60 * MIN, T0 + 4 * 60 * MIN, T0 + 5 * 60 * MIN);
    expect(thin.summary.thinnedToSeconds).toBe(2);
    expect(thin.points.length).toBeLessThanOrEqual(HISTORY_RULES.maxTrackPoints);
  });
});

describe("CSV", () => {
  it("leaves negative numbers alone but still neutralises formulas", () => {
    expect(toCsv([[-79.5, "-79.500000", "=SUM(A1)", "-cmd"]])).toBe("-79.5,-79.500000,'=SUM(A1),'-cmd\r\n");
  });
});
