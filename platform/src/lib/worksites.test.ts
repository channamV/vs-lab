import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, notificationEvents, organizations, users, worksiteVisits } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { createRule, ruleMatches } from "@/lib/notifications";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { checkPolygon, distanceToEdgeM, pointInPolygon, type Polygon } from "./worksite-types";
import { checkDwell, createWorksite, deleteWorksite, setWorksitePerimeter, updatePresence, updateWorksite, WorksiteError } from "./worksites";

/** A ~220 m square around Toronto city hall. */
const yard: Polygon = [
  [43.652, -79.385],
  [43.654, -79.385],
  [43.654, -79.382],
  [43.652, -79.382],
];
const inside = { lat: 43.653, lng: -79.3835 };
const justOutside = { lat: 43.6541, lng: -79.3835 }; // ~11 m north of the edge
const farOutside = { lat: 43.656, lng: -79.3835 }; // ~220 m north

let db: Db;
let org: number;
let machineId: number;
const t0 = new Date("2026-10-21T13:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const events = async () => (await db.select().from(notificationEvents).orderBy(notificationEvents.id)).filter((e) => e.type.startsWith("worksite"));

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org, { name: "Excavator", unitNumber: "14" }));
});

const site = (extra: Partial<Parameters<typeof createWorksite>[3]> = {}) =>
  createWorksite(db, org, null, { name: "North Yard", type: "yard_storage", notes: "", dwellLimitMinutes: null, polygon: yard, ...extra });
const machine = () => ({ id: machineId, organizationId: org });

describe("geometry", () => {
  it("tells inside from outside and measures the distance to the edge", () => {
    expect(pointInPolygon(inside.lat, inside.lng, yard)).toBe(true);
    expect(pointInPolygon(justOutside.lat, justOutside.lng, yard)).toBe(false);
    expect(distanceToEdgeM(justOutside.lat, justOutside.lng, yard)).toBeCloseTo(11, 0);
    expect(distanceToEdgeM(farOutside.lat, farOutside.lng, yard)).toBeCloseTo(222, -1);
  });

  it("checks drawn boundaries", () => {
    expect(checkPolygon([[1, 1], [1, 2]])).toEqual({ ok: false, error: "The boundary needs at least 3 corners." });
    expect(checkPolygon([[43.65, -79.38], [43.65001, -79.38], [43.65001, -79.37999]])).toMatchObject({ ok: false, error: expect.stringMatching(/too small/) });
    expect(checkPolygon("nonsense")).toMatchObject({ ok: false });
    // A closed ring (first corner repeated) is accepted and opened.
    expect(checkPolygon([...yard, yard[0]])).toEqual({ ok: true, polygon: yard });
  });
});

describe("worksites", () => {
  it("are named uniquely per organization and validated", async () => {
    const s = await site();
    expect(s).toMatchObject({ name: "North Yard", centerLat: expect.closeTo(43.653, 6), centerLng: expect.closeTo(-79.3835, 6) });
    await expect(site()).rejects.toThrow(/already a worksite/);
    await expect(site({ name: "Other", type: "castle" })).rejects.toThrow(/type/);
    await expect(site({ name: "Other", dwellLimitMinutes: 2 })).rejects.toThrow(/time limit/);
    await expect(updateWorksite(db, org + 1, s.id, { name: "X", type: "worksite", notes: "", dwellLimitMinutes: null })).rejects.toBeInstanceOf(WorksiteError);
  });
});

describe("entering and leaving", () => {
  it("records enter and leave once each, ignoring GPS wobble along the edge", async () => {
    const s = await site();
    expect(await updatePresence(db, machine(), farOutside, at(0))).toBe(0);
    expect(await updatePresence(db, machine(), inside, at(1))).toBe(1);
    expect(await updatePresence(db, machine(), inside, at(2))).toBe(0);
    expect(await updatePresence(db, machine(), justOutside, at(3))).toBe(0); // within 30 m: still there
    expect(await updatePresence(db, machine(), inside, at(4))).toBe(0);
    expect(await updatePresence(db, machine(), inside, at(5))).toBe(0);
    expect(await updatePresence(db, machine(), farOutside, at(95))).toBe(1);
    const [enter, leave] = await events();
    expect(enter).toMatchObject({ type: "worksite_enter", worksiteId: s.id, detail: 'Entered "North Yard" (Yard / storage).', occurredAt: at(1) });
    expect(leave).toMatchObject({ type: "worksite_leave", worksiteId: s.id, worksiteVisitId: enter.worksiteVisitId, detail: 'Left "North Yard" (Yard / storage) after 1 h 34 min.' });
    expect(await db.select().from(worksiteVisits)).toMatchObject([{ enteredAt: at(1), lastInsideAt: at(5), leftAt: at(95) }]);
  });

  it("ignores rough fixes, handles overlapping sites, and follows a redrawn boundary", async () => {
    const a = await site();
    const b = await site({ name: "Whole block", type: "worksite", polygon: yard.map(([lat, lng]) => [lat + (lat > 43.653 ? 0.001 : -0.001), lng]) });
    expect(await updatePresence(db, machine(), { ...inside, satellites: 3 }, at(0))).toBe(0);
    expect(await updatePresence(db, machine(), { ...inside, satellites: 9 }, at(1))).toBe(2);
    // Shrink "North Yard" away from the machine: it leaves that one only.
    await setWorksitePerimeter(db, org, a.id, yard.map(([lat, lng]) => [lat, lng + 0.01]));
    expect(await updatePresence(db, machine(), inside, at(2))).toBe(1);
    expect((await events()).map((e) => [e.type, e.worksiteId])).toEqual([
      ["worksite_enter", a.id],
      ["worksite_enter", b.id],
      ["worksite_leave", a.id],
    ]);
    // Deleting a site removes its visits.
    await deleteWorksite(db, org, b.id);
    expect(await db.select().from(worksiteVisits).where(eq(worksiteVisits.worksiteId, b.id))).toEqual([]);
  });

  it("works from real device reports", async () => {
    await site();
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", machineId, at(-10));
    await ingestSamples(db, "DEV1", [{ lat: inside.lat, lng: inside.lng, satellites: 10 }], { now: at(0) });
    await ingestSamples(db, "DEV1", [{ lat: farOutside.lat, lng: farOutside.lng, satellites: 10 }], { now: at(30) });
    expect((await events()).map((e) => e.type)).toEqual(["worksite_enter", "worksite_leave"]);
  });
});

describe("stays too long", () => {
  it("records one event per visit once the site's limit is passed", async () => {
    await site({ dwellLimitMinutes: 120 });
    await updatePresence(db, machine(), inside, at(0));
    expect(await checkDwell(db, at(119))).toBe(0);
    expect(await checkDwell(db, at(121))).toBe(1);
    expect(await checkDwell(db, at(180))).toBe(0);
    const dwell = (await events()).find((e) => e.type === "worksite_dwell")!;
    expect(dwell.detail).toMatch(/^Has been at "North Yard" for more than 2 h \(since /);
  });
});

describe("subscriptions", () => {
  it("can be limited to some worksites, which only affects worksite events", async () => {
    const a = await site();
    const b = await site({ name: "South Yard", polygon: yard.map(([lat, lng]) => [lat - 0.01, lng]) });
    const [user] = await db.insert(users).values({ organizationId: org, email: "m@abc.ca", role: "manager" }).returning();
    const rule = await createRule(db, org, user.id, {
      name: "Yard",
      eventTypes: ["worksite_enter", "start"],
      machineIds: [],
      divisionIds: [],
      operatorIds: [],
      worksiteIds: [a.id],
      weekdays: [],
      startTime: "",
      endTime: "",
    });
    expect(rule.worksiteIds).toEqual([a.id]);
    const m = { id: machineId, divisionId: null };
    const ev = (type: string, worksiteId: number | null) => ({ type, worksiteId, operatorId: null, occurredAt: t0 });
    expect(ruleMatches(rule, ev("worksite_enter", a.id), m)).toBe(true);
    expect(ruleMatches(rule, ev("worksite_enter", b.id), m)).toBe(false);
    expect(ruleMatches(rule, ev("start", null), m)).toBe(true);
    // Without a worksite event, the worksite filter is dropped.
    const plain = await createRule(db, org, user.id, { ...rule, name: "Starts", eventTypes: ["start"], worksiteIds: [a.id] });
    expect(plain.worksiteIds).toEqual([]);
    await expect(createRule(db, org, user.id, { ...rule, name: "Bad", worksiteIds: [999] })).rejects.toThrow(/Worksite not found/);
  });
});
