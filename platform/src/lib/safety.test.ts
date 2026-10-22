import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, engineSessions, machines, notificationEvents, operators, organizations, safetyEvents } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { applyRetention, eraseOperator, exportOperator } from "@/lib/privacy";
import { ingestSamples } from "@/lib/telemetry/ingest";
import type { Polygon } from "@/lib/worksite-types";
import { createWorksite } from "@/lib/worksites";
import { checkFatigue, checkRestrictedAreas, continuousBlocks, hoursBetween, idleState, parseSiteSpeedLimit, SafetyError, updateSafetySettings } from "./safety";

const yard: Polygon = [
  [43.652, -79.385],
  [43.654, -79.385],
  [43.654, -79.382],
  [43.652, -79.382],
];
const inYard = { lat: 43.653, lng: -79.3835, satellites: 9 };
const outside = { lat: 43.66, lng: -79.3835, satellites: 9 };

let db: Db;
let org: number;
let machineId: number;
const t0 = new Date("2026-10-21T13:00:00Z"); // 9 AM Toronto
const at = (sec: number) => new Date(t0.getTime() + sec * 1000);
const report = (sec: number, fields: Record<string, number>) => ingestSamples(db, "DEV1", [fields], { now: at(sec) });
const events = async (type: string) => db.select().from(notificationEvents).where(eq(notificationEvents.type, type));
const log = () => db.select().from(safetyEvents).orderBy(safetyEvents.id);

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org, { name: "Loader", unitNumber: "7" }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-3600));
});

describe("settings", () => {
  it("saves limits, blank = off, and rejects nonsense", async () => {
    await updateSafetySettings(db, org, { speedLimitKph: "40", idleAlertMinutes: "", fatigueDailyHours: "12", fatigueContinuousHours: "4.5" });
    const [o] = await db.select().from(organizations).where(eq(organizations.id, org));
    expect(o).toMatchObject({ speedLimitKph: 40, idleAlertMinutes: null, fatigueDailyHours: 12, fatigueContinuousHours: 4.5 });
    await expect(updateSafetySettings(db, org, { speedLimitKph: "1", idleAlertMinutes: "", fatigueDailyHours: "", fatigueContinuousHours: "" })).rejects.toThrow(SafetyError);
    await expect(updateSafetySettings(db, org, { speedLimitKph: "", idleAlertMinutes: "7.5", fatigueDailyHours: "", fatigueContinuousHours: "" })).rejects.toThrow(/whole minutes/);
    expect(parseSiteSpeedLimit(" ")).toBeNull();
    expect(parseSiteSpeedLimit("15")).toBe(15);
    expect(() => parseSiteSpeedLimit("abc")).toThrow(SafetyError);
  });
});

describe("speeding", () => {
  beforeEach(async () => {
    await db.update(organizations).set({ speedLimitKph: 40 }).where(eq(organizations.id, org));
  });

  it("ignores a brief GPS spike", async () => {
    await report(0, { ...outside, speedKph: 70 });
    await report(4, { ...outside, speedKph: 30 });
    expect(await log()).toEqual([]);
    expect(await events("speeding")).toEqual([]);
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m.speedingEventId).toBeNull();
  });

  it("logs and notifies a spell over 10 seconds once, with the peak", async () => {
    for (const [sec, speed] of [[0, 45], [5, 52], [10, 61], [15, 48], [20, 41]]) await report(sec, { ...outside, speedKph: speed });
    expect(await events("speeding")).toHaveLength(1);
    expect((await events("speeding"))[0].detail).toBe("61 km/h — over the fleet limit of 40 km/h.");
    // 41 km/h is within the 2 km/h margin: the spell ended at 20 s.
    await report(25, { ...outside, speedKph: 20 });
    const [spell] = await log();
    expect(spell).toMatchObject({ kind: "speeding", peak: 61, limitValue: 40, startedAt: at(0), endedAt: at(20) });
    // A new spell is a new entry.
    for (const sec of [60, 65, 72]) await report(sec, { ...outside, speedKph: 50 });
    expect(await log()).toHaveLength(2);
    expect(await events("speeding")).toHaveLength(2);
  });

  it("ignores speeds from a poor GPS fix", async () => {
    for (const sec of [0, 5, 12]) await report(sec, { ...outside, satellites: 3, speedKph: 90 });
    expect(await log()).toEqual([]);
  });

  it("uses a worksite's lower limit while the machine is in it", async () => {
    const site = await createWorksite(db, org, null, { name: "North Yard", type: "yard_storage", notes: "", dwellLimitMinutes: null, speedLimitKph: 15, polygon: yard });
    for (const sec of [0, 5, 11]) await report(sec, { ...inYard, speedKph: 25 });
    const [spell] = await log();
    expect(spell).toMatchObject({ kind: "speeding", limitValue: 15, worksiteId: site.id });
    expect((await events("speeding"))[0].detail).toBe("25 km/h — over the North Yard site limit of 15 km/h.");
  });

  it("uses the machine's own top speed instead of the fleet limit, unless a site's is lower", async () => {
    await db.update(machines).set({ speedLimitKph: 25 }).where(eq(machines.id, machineId));
    for (const sec of [0, 5, 11]) await report(sec, { ...outside, speedKph: 30 });
    expect((await events("speeding"))[0].detail).toBe("30 km/h — over the machine's top speed of 25 km/h.");
    // Higher than the fleet limit: a truck allowed 60 isn't speeding at 50.
    await db.update(machines).set({ speedLimitKph: 60 }).where(eq(machines.id, machineId));
    for (const sec of [100, 105, 111]) await report(sec, { ...outside, speedKph: 50 });
    expect(await events("speeding")).toHaveLength(1);
    // A yard limit of 15 still applies inside the yard.
    await createWorksite(db, org, null, { name: "North Yard", type: "yard_storage", notes: "", dwellLimitMinutes: null, speedLimitKph: 15, polygon: yard });
    for (const sec of [200, 205, 211]) await report(sec, { ...inYard, speedKph: 20 });
    expect((await events("speeding"))[1].detail).toBe("20 km/h — over the North Yard site limit of 15 km/h.");
  });

  it("does nothing without a limit", async () => {
    await db.update(organizations).set({ speedLimitKph: null }).where(eq(organizations.id, org));
    for (const sec of [0, 5, 11]) await report(sec, { ...outside, speedKph: 120 });
    expect(await log()).toEqual([]);
  });

  it("ends a spell at the last report when the device goes quiet", async () => {
    for (const sec of [0, 5, 11]) await report(sec, { ...outside, speedKph: 60 });
    await report(11 + 600, { ...outside, speedKph: 60 });
    const spells = await log();
    expect(spells[0].endedAt).toEqual(at(11));
    expect(spells[1]).toMatchObject({ endedAt: null, notifiedAt: null }); // a new spell, not yet 10 s long
  });
});

describe("excessive idling", () => {
  beforeEach(async () => {
    await db.update(organizations).set({ idleAlertMinutes: 30 }).where(eq(organizations.id, org));
  });

  it("tells idling from working and off", () => {
    expect(idleState({ rpm: 750, speedKph: 0, satellites: 9, engineOn: true })).toBe("idle");
    expect(idleState({ rpm: 750, speedKph: 8, satellites: 9, engineOn: true })).toBe("working");
    expect(idleState({ rpm: 1600, speedKph: 0, satellites: 9, engineOn: true })).toBe("working");
    expect(idleState({ rpm: 0, speedKph: 0, satellites: 9, engineOn: false })).toBe("off");
    expect(idleState({ rpm: null, speedKph: 0, satellites: 9, engineOn: true })).toBeNull();
  });

  it("notifies once after the limit and records how long it lasted", async () => {
    for (let min = 0; min <= 29; min++) await report(min * 60, { obdRpm: 750, speedKph: 0 });
    expect(await events("excessive_idle")).toEqual([]);
    for (let min = 30; min <= 44; min++) await report(min * 60, { obdRpm: 760, speedKph: 0 });
    expect(await events("excessive_idle")).toHaveLength(1);
    await report(45 * 60, { obdRpm: 1800, speedKph: 5 });
    const [idle] = await log();
    expect(idle).toMatchObject({ kind: "excessive_idle", startedAt: at(0), endedAt: at(45 * 60), peak: 45, limitValue: 30 });
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m).toMatchObject({ idleSince: null, idleEventId: null });
  });

  it("starts over after a long silence", async () => {
    for (let min = 0; min <= 20; min++) await report(min * 60, { obdRpm: 750 });
    for (let min = 30; min <= 45; min++) await report(min * 60, { obdRpm: 750 });
    expect(await log()).toEqual([]);
  });

  it("starts over when the machine works in between", async () => {
    for (let min = 0; min <= 45; min++) await report(min * 60, { obdRpm: min === 20 ? 1500 : 750 });
    expect(await log()).toEqual([]);
  });
});

describe("restricted areas", () => {
  it("raises one alert per entry, and logs it", async () => {
    await createWorksite(db, org, null, { name: "Rail corridor", type: "restricted", notes: "No equipment without a flagger", dwellLimitMinutes: null, polygon: yard });
    await report(0, inYard);
    const raised = await checkRestrictedAreas(db, machineId, at(1));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: "restricted-area", title: "Restricted area: Unit 7 · Loader entered Rail corridor" });
    expect(raised[0].detail).toMatch(/\(No equipment without a flagger\)/);
    await report(10, inYard);
    expect(await checkRestrictedAreas(db, machineId, at(11))).toEqual([]);
    await report(60, outside);
    await checkRestrictedAreas(db, machineId, at(61));
    const [entry] = await log();
    expect(entry).toMatchObject({ kind: "restricted_area", endedAt: at(60) });
    await report(120, inYard);
    expect(await checkRestrictedAreas(db, machineId, at(121))).toHaveLength(1);
  });

  it("ignores ordinary worksites", async () => {
    await createWorksite(db, org, null, { name: "Yard", type: "yard_storage", notes: "", dwellLimitMinutes: null, polygon: yard });
    await report(0, inYard);
    expect(await checkRestrictedAreas(db, machineId, at(1))).toEqual([]);
  });
});

describe("operator fatigue", () => {
  const h = (hours: number) => new Date(t0.getTime() + hours * 3_600_000);
  let jane: number;
  beforeEach(async () => {
    [{ id: jane }] = await db.insert(operators).values({ organizationId: org, name: "Jane Smith", pinHash: "x" }).returning();
  });
  const worked = async (from: number, to: number) => {
    await db.insert(engineSessions).values({ machineId, startedAt: h(from), endedAt: h(to), lastSeenAt: h(to) });
    await db.insert(checkins).values({ organizationId: org, machineId, operatorId: jane, startedAt: h(from), endedAt: h(to), authorized: true, checklistOk: true, answers: [] });
  };

  it("merges engine time with short gaps into continuous stretches", () => {
    const blocks = continuousBlocks([
      { start: 0, end: 60 * 60_000, machineId: 1 },
      { start: 70 * 60_000, end: 120 * 60_000, machineId: 2 },
      { start: 150 * 60_000, end: 160 * 60_000, machineId: 1 },
    ]);
    expect(blocks.map((b) => [b.start / 60_000, b.end / 60_000])).toEqual([[0, 120], [150, 160]]);
    expect(hoursBetween([{ start: 0, end: 3_600_000, machineId: 1 }, { start: 1_800_000, end: 5_400_000, machineId: 1 }], 0, 10e6)).toBe(1.5);
  });

  it("flags too long without a break, once per stretch", async () => {
    await db.update(organizations).set({ fatigueContinuousHours: 4, fatigueDailyHours: null }).where(eq(organizations.id, org));
    await worked(0, 2);
    await worked(2.1, 4.5); // a 6-minute gap isn't a break
    expect(await checkFatigue(db, h(4.5))).toBe(1);
    expect(await checkFatigue(db, h(4.6))).toBe(0);
    const [e] = await log();
    expect(e).toMatchObject({ kind: "fatigue_continuous", operatorId: jane, limitValue: 4, peak: 4.5 });
    expect((await events("operator_fatigue"))[0].detail).toMatch(/^Jane Smith has operated for 4 h 30 min without a 15-minute break/);
  });

  it("flags a long day once, and a proper break resets the stretch", async () => {
    await db.update(organizations).set({ fatigueContinuousHours: 5, fatigueDailyHours: 7 }).where(eq(organizations.id, org));
    await worked(-2, 2); // 7–11 AM
    await worked(2.5, 6); // break, then 11:30–3 PM
    expect(await checkFatigue(db, h(6))).toBe(1);
    expect((await log()).map((e) => e.kind)).toEqual(["fatigue_daily"]);
    expect(await checkFatigue(db, h(6.1))).toBe(0);
  });

  it("is off when the limits are blank", async () => {
    await db.update(organizations).set({ fatigueContinuousHours: null, fatigueDailyHours: null }).where(eq(organizations.id, org));
    await worked(-2, 10);
    expect(await checkFatigue(db, h(10))).toBe(0);
  });
});

describe("privacy", () => {
  it("exports, scrubs on erasure and expires the safety log", async () => {
    const [{ id: jane }] = await db.insert(operators).values({ organizationId: org, name: "Jane Smith", pinHash: "x" }).returning();
    await db.insert(safetyEvents).values({ organizationId: org, machineId, operatorId: jane, kind: "fatigue_daily", startedAt: t0, notifiedAt: t0, detail: "Jane Smith has operated machines for 13 h today" });
    expect((await exportOperator(db, org, jane)).safetyLog).toHaveLength(1);
    await eraseOperator(db, org, jane);
    const [e] = await log();
    expect(e.detail).toBe(`Former operator #${jane} has operated machines for 13 h today`);
    await applyRetention(db, new Date(t0.getTime() + 1200 * 86_400_000));
    expect(await log()).toEqual([]);
  });
});
