import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, checkins, devices, divisions, engineSessions, operators, organizations, telemetry, worksites, worksiteVisits } from "@/lib/db/schema";
import { createMachine } from "@/lib/machines";
import { hashPin } from "@/lib/operators";
import { buildReport, overlapMs, plannedHours, reportRange, splitByDay, toCsv, REPORT_CSV } from "./reports";

const tz = "America/Toronto";
/** Wed 21 Oct 2026, 15:00 Toronto. */
const now = Date.parse("2026-10-21T19:00:00Z");
const toronto = (local: string) => new Date(Date.parse(`${local}:00-04:00`));

describe("date ranges", () => {
  it("covers the presets in the company's time zone, ending now", () => {
    const week = reportRange({}, now, tz);
    expect(week).toMatchObject({ preset: "7d", fromDate: "2026-10-15", toDate: "2026-10-21", label: "Last 7 days", to: now });
    expect(week.days).toHaveLength(7);
    expect(new Date(week.from).toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(reportRange({ range: "month" }, now, tz)).toMatchObject({ fromDate: "2026-10-01", toDate: "2026-10-21" });
    const last = reportRange({ range: "lastmonth" }, now, tz);
    expect(last).toMatchObject({ fromDate: "2026-09-01", toDate: "2026-09-30" });
    expect(new Date(last.to).toISOString()).toBe("2026-10-01T04:00:00.000Z");
  });

  it("cleans up custom ranges", () => {
    expect(reportRange({ range: "custom", from: "2026-10-20", to: "2026-10-10" }, now, tz)).toMatchObject({ fromDate: "2026-10-10", toDate: "2026-10-20" });
    expect(reportRange({ range: "custom", from: "2026-10-20", to: "2027-01-01" }, now, tz)).toMatchObject({ toDate: "2026-10-21" });
    expect(reportRange({ range: "custom", from: "2025-01-01", to: "2026-10-21" }, now, tz).days).toHaveLength(92);
    expect(reportRange({ range: "custom", from: "nonsense" }, now, tz)).toMatchObject({ preset: "7d" });
  });

  it("splits time across midnight and counts planned hours on working days only", () => {
    const range = reportRange({}, now, tz);
    const split = splitByDay(toronto("2026-10-19T22:00").getTime(), toronto("2026-10-20T02:30").getTime(), range, tz);
    expect([...split].map(([d, ms]) => [d, ms / 3_600_000])).toEqual([["2026-10-19", 2], ["2026-10-20", 2.5]]);
    expect(plannedHours(range, 8, [1, 2, 3, 4, 5])).toBe(40); // Thu 15 – Wed 21: 5 weekdays
    expect(overlapMs([[0, 10]], [[5, 20], [-5, 2]])).toBe(7);
  });
});

describe("report", () => {
  let db: Db;
  let org: number;
  let a: number;
  let b: number;
  let hidden: number;
  let jane: number;

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
    const [east] = await db.insert(divisions).values({ organizationId: org, name: "East" }).returning();
    const [west] = await db.insert(divisions).values({ organizationId: org, name: "West" }).returning();
    ({ id: a } = await createMachine(db, org, { name: "Excavator", unitNumber: "1", divisionId: east.id }));
    ({ id: b } = await createMachine(db, org, { name: "Loader", unitNumber: "2", divisionId: east.id }));
    ({ id: hidden } = await createMachine(db, org, { name: "Dozer", unitNumber: "3", divisionId: west.id }));
    [{ id: jane }] = await db.insert(operators).values({ organizationId: org, name: "Jane", pinHash: hashPin("1111") }).returning();

    // Excavator: Mon 19 Oct 08:00–12:00 with Jane checked in, Tue 20 Oct 08:00–10:00 with nobody.
    const [s1] = await db
      .insert(engineSessions)
      .values({ machineId: a, startedAt: toronto("2026-10-19T08:00"), endedAt: toronto("2026-10-19T12:00"), lastSeenAt: toronto("2026-10-19T12:00") })
      .returning();
    await db.insert(engineSessions).values({ machineId: a, startedAt: toronto("2026-10-20T08:00"), endedAt: toronto("2026-10-20T10:00"), lastSeenAt: toronto("2026-10-20T10:00") });
    await db.insert(checkins).values({
      organizationId: org,
      machineId: a,
      operatorId: jane,
      startedAt: toronto("2026-10-19T07:58"),
      endedAt: toronto("2026-10-19T12:00"),
      authorized: true,
      checklistOk: false,
      answers: [],
      engineSessionId: s1.id,
    });
    await db.insert(alerts).values({ organizationId: org, machineId: a, type: "unauthorized-use", title: "x", createdAt: toronto("2026-10-20T08:05") });
    // Idle: on Monday 1 of 4 running samples was stationary.
    await db.insert(devices).values({ id: "D1" });
    await db.insert(telemetry).values(
      [0, 5, 5, 5].map((speed) => ({ deviceId: "D1", machineId: a, receivedAt: toronto("2026-10-19T09:00"), speedKph: speed, engineOn: true, fields: {} })),
    );
    // Dozer (another division) ran too: limited users mustn't see it.
    await db.insert(engineSessions).values({ machineId: hidden, startedAt: toronto("2026-10-19T08:00"), endedAt: toronto("2026-10-19T18:00"), lastSeenAt: toronto("2026-10-19T18:00") });
    // The excavator spent Monday 07:00–13:00 at the yard.
    const [yard] = await db
      .insert(worksites)
      .values({ organizationId: org, name: "Yard", type: "yard_storage", polygon: [[0, 0], [0, 1], [1, 1]], centerLat: 0, centerLng: 0 })
      .returning();
    await db.insert(worksiteVisits).values({
      organizationId: org,
      machineId: a,
      worksiteId: yard.id,
      enteredAt: toronto("2026-10-19T07:00"),
      lastInsideAt: toronto("2026-10-19T13:00"),
      leftAt: toronto("2026-10-19T13:00"),
    });
  });

  it("adds up hours, idle, utilization, operators, compliance and worksites", async () => {
    const range = reportRange({}, now, tz);
    const r = await buildReport(db, { organizationId: org, divisionIds: null }, range, tz, { now });
    const exc = r.machines.find((m) => m.id === a)!;
    expect(exc).toMatchObject({
      hours: 6,
      idleHours: 1, // 4 h on Monday × ¼ stationary
      coveredHours: 4,
      daysUsed: 2,
      daysWithCheckin: 1,
      missedDays: ["2026-10-20"],
      checkins: 1,
      checkinsWithDefects: 1,
      startsWithoutCheckin: 1,
      topWorksite: "Yard",
      utilization: 6 / 40,
    });
    expect(exc.hoursByDay).toEqual({ "2026-10-19": 4, "2026-10-20": 2 });
    expect(r.machines.find((m) => m.id === b)).toMatchObject({ hours: 0, daysUsed: 0, lastUsed: null });
    expect(r.operators).toEqual([{ id: jane, name: "Jane", hours: 4, checkins: 1, machines: 1, days: 1, defects: 1 }]);
    expect(r.worksites).toEqual([
      expect.objectContaining({ name: "Yard", visits: 1, machines: 1, timeOnSiteHours: 6, engineHours: 4, avgVisitHours: 6 }),
    ]);
    expect(r.totals).toMatchObject({ hours: 16, machines: 3, activeMachines: 2, activeOperators: 1, daysOperated: 3, daysWithCheckin: 1 });
  });

  it("only includes machines the user can see, or the chosen division", async () => {
    const range = reportRange({}, now, tz);
    const [east] = await db.select().from(divisions).limit(1);
    const limited = await buildReport(db, { organizationId: org, divisionIds: [east.id] }, range, tz, { now });
    expect(limited.machines.map((m) => m.name)).toEqual(["Excavator", "Loader"]);
    expect(limited.totals.hours).toBe(6);
    const byDivision = await buildReport(db, { organizationId: org, divisionIds: null }, range, tz, { now, divisionId: east.id });
    expect(byDivision.machines).toHaveLength(2);
  });

  it("reads fuel and hours from the engine computer's meters", async () => {
    await db.insert(telemetry).values([
      { deviceId: "D1", machineId: a, receivedAt: toronto("2026-10-19T08:00"), engineOn: true, fields: { j1939EngineHours: 1500.0, j1939TotalFuelL: 20000 } },
      { deviceId: "D1", machineId: a, receivedAt: toronto("2026-10-20T10:00"), engineOn: true, fields: { j1939EngineHours: 1506.1, j1939TotalFuelL: 20096.5 } },
    ]);
    const r = await buildReport(db, { organizationId: org, divisionIds: null }, reportRange({}, now, tz), tz, { now });
    expect(r.machines.find((m) => m.id === a)).toMatchObject({ meterHours: expect.closeTo(6.1, 5), fuelL: expect.closeTo(96.5, 5) });
    expect(r.machines.find((m) => m.id === b)).toMatchObject({ meterHours: null, fuelL: null });
    expect(r.totals).toMatchObject({ fuelMachines: 1, fuelL: expect.closeTo(96.5, 5) });
  });

  it("exports CSV safely", async () => {
    const r = await buildReport(db, { organizationId: org, divisionIds: null }, reportRange({}, now, tz), tz, { now });
    const csv = toCsv(REPORT_CSV.machines(r));
    expect(csv.split("\r\n")[0]).toMatch(/^Unit,Machine,Type,Division,Engine hours,Idle hours \(est.\),Idle %,Days used,Utilization %,Last used,Most time at worksite,Hour meter/);
    expect(csv).toContain("1,Excavator,,East,6.00,1.00,16.7,2,15.0,");
    expect(toCsv([["=HYPERLINK(1)", 'say "hi", ok']])).toBe(`'=HYPERLINK(1),"say ""hi"", ok"\r\n`);
  });
});
