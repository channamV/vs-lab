import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkinPhotos, checkins, divisions, machines, organizations, type ChecklistAnswer } from "@/lib/db/schema";
import { type Scope } from "@/lib/divisions";
import { createMachine } from "@/lib/machines";
import { createOperator } from "@/lib/operators";
import { checklistResultById, filterQuery, parseResultFilters, queryChecklistResults, resultOf, resultsCsvRows } from "./checklist-results";

const TZ = "America/St_Johns";
const NOW = Date.parse("2026-10-26T15:00:00Z");

describe("parseResultFilters", () => {
  it("defaults to the last 30 days, all results, without covered check-ins", () => {
    const f = parseResultFilters({}, NOW, TZ);
    expect(f).toMatchObject({ machineId: null, operatorId: null, divisionId: null, result: "all", includeCovered: false, page: 1 });
    expect(f.range.preset).toBe("30d");
    expect(filterQuery(f)).toBe("range=30d");
  });

  it("reads the filters and ignores junk", () => {
    const f = parseResultFilters({ machine: "4", operator: "x", result: "defects", covered: "1", page: "3" }, NOW, TZ);
    expect(f).toMatchObject({ machineId: 4, operatorId: null, result: "defects", includeCovered: true, page: 3 });
    expect(parseResultFilters({ result: "nope" }, NOW, TZ).result).toBe("all");
    expect(filterQuery(f, { page: 4 })).toBe("range=30d&machine=4&result=defects&covered=1&page=4");
  });

  it("allows custom ranges up to a year (audits)", () => {
    const f = parseResultFilters({ range: "custom", from: "2026-01-01", to: "2026-10-26" }, NOW, TZ);
    expect([f.range.fromDate, f.range.toDate]).toEqual(["2026-01-01", "2026-10-26"]);
    expect(filterQuery(f)).toBe("range=custom&from=2026-01-01&to=2026-10-26");
  });
});

describe("resultOf", () => {
  it("covered, then locked out, then OK or defects", () => {
    expect(resultOf({ checklistOk: true, lockoutRequested: false, checklistFromCheckinId: 5 })).toBe("covered");
    expect(resultOf({ checklistOk: false, lockoutRequested: true, checklistFromCheckinId: null })).toBe("locked_out");
    expect(resultOf({ checklistOk: true, lockoutRequested: false, checklistFromCheckinId: null })).toBe("ok");
    expect(resultOf({ checklistOk: false, lockoutRequested: false, checklistFromCheckinId: null })).toBe("defects");
  });
});

describe("queryChecklistResults", () => {
  let db: Db;
  let orgId: number;
  let loader: number;
  let truck: number;
  let jane: number;
  let bob: number;
  let east: number;
  const ok: ChecklistAnswer[] = [
    { id: "tires", section: "Walk-around", question: "Tires", ok: true, answer: "OK", severity: "pass" },
    { id: "odo", section: "Trip", question: "Odometer", ok: true, answer: "12345", textOnly: true },
  ];
  const bad: ChecklistAnswer[] = [{ id: "tires", section: "Walk-around", question: "Tires", ok: false, answer: "Major defect", severity: "major", note: "Flat front left" }];
  const at = (h: number) => new Date(NOW - h * 3600_000);
  const all = (): Scope => ({ organizationId: orgId, divisionIds: null });
  let ids: Record<string, number>;

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: orgId }] = await db.insert(organizations).values({ name: "ABC" }).returning();
    const [other] = await db.insert(organizations).values({ name: "Other" }).returning();
    [{ id: east }] = await db.insert(divisions).values({ organizationId: orgId, name: "East" }).returning();
    ({ id: loader } = await createMachine(db, orgId, { name: "Loader", tier: "monitor" }));
    ({ id: truck } = await createMachine(db, orgId, { name: "Truck", tier: "monitor" }));
    await db.update(machines).set({ divisionId: east, unitNumber: "14" }).where(eq(machines.id, truck));
    const { id: otherMachine } = await createMachine(db, other.id, { name: "Theirs", tier: "monitor" });
    jane = (await createOperator(db, orgId, { name: "Jane", pin: "1111" })).id;
    bob = (await createOperator(db, orgId, { name: "Bob", pin: "2222" })).id;
    const otherOp = (await createOperator(db, other.id, { name: "Zed", pin: "3333" })).id;
    const add = async (v: Partial<typeof checkins.$inferInsert> & { machineId: number; operatorId: number }) =>
      (
        await db
          .insert(checkins)
          .values({ organizationId: orgId, authorized: true, checklistOk: true, answers: ok, templateName: "Daily", endedAt: new Date(v.startedAt!.getTime() + 1800_000), ...v })
          .returning()
      )[0].id;
    ids = {
      okLoader: await add({ machineId: loader, operatorId: jane, startedAt: at(5), confirmationText: "I did it" }),
      badTruck: await add({ machineId: truck, operatorId: bob, startedAt: at(4), checklistOk: false, answers: bad, notes: "Needs a tire" }),
      locked: await add({ machineId: truck, operatorId: jane, startedAt: at(3), checklistOk: false, answers: bad, lockoutRequested: true }),
      old: await add({ machineId: loader, operatorId: jane, startedAt: at(24 * 40) }),
    };
    ids.covered = await add({ machineId: truck, operatorId: jane, startedAt: at(2), answers: [], checklistFromCheckinId: ids.badTruck });
    await db.insert(checkins).values({ organizationId: other.id, machineId: otherMachine, operatorId: otherOp, authorized: true, checklistOk: true, answers: ok, startedAt: at(1), endedAt: at(0.5) });
    await db.insert(checkinPhotos).values({ organizationId: orgId, machineId: truck, checkinId: ids.badTruck, questionId: "tires", storageKey: "x", contentType: "image/jpeg", bytes: 1, takenAt: at(4) });
  });

  const query = async (params: Record<string, string>, scope = all()) =>
    queryChecklistResults(db, orgId, scope, parseResultFilters(params, NOW, TZ));

  it("lists the organization's checklists in range, newest first, without covered check-ins", async () => {
    const { total, rows } = await query({});
    expect(total).toBe(3);
    expect(rows.map((r) => r.id)).toEqual([ids.locked, ids.badTruck, ids.okLoader]);
    expect(rows.map((r) => r.result)).toEqual(["locked_out", "defects", "ok"]);
    expect(rows[1].photos).toHaveLength(1);
  });

  it("filters by result, machine, operator, division and covered", async () => {
    expect((await query({ result: "defects" })).rows.map((r) => r.id)).toEqual([ids.locked, ids.badTruck]);
    expect((await query({ result: "locked_out" })).rows.map((r) => r.id)).toEqual([ids.locked]);
    expect((await query({ result: "ok", covered: "1" })).rows.map((r) => r.id)).toEqual([ids.okLoader]);
    expect((await query({ machine: String(loader) })).rows.map((r) => r.id)).toEqual([ids.okLoader]);
    expect((await query({ operator: String(bob) })).rows.map((r) => r.id)).toEqual([ids.badTruck]);
    expect((await query({ division: String(east) })).total).toBe(2);
    expect((await query({ covered: "1" })).rows.map((r) => r.id)).toEqual([ids.covered, ids.locked, ids.badTruck, ids.okLoader]);
    expect((await query({ range: "90d" })).total).toBe(4);
  });

  it("limits division-restricted users to their divisions", async () => {
    expect((await query({}, { organizationId: orgId, divisionIds: [east] })).rows.map((r) => r.id)).toEqual([ids.locked, ids.badTruck]);
    expect(await checklistResultById(db, orgId, { organizationId: orgId, divisionIds: [east] }, ids.okLoader)).toBeNull();
  });

  it("returns one result with its photos and the checklist that covered it, never another organization's", async () => {
    const r = await checklistResultById(db, orgId, all(), ids.covered);
    expect(r).toMatchObject({ result: "covered", covering: { id: ids.badTruck, operatorName: "Bob" } });
    expect((await checklistResultById(db, orgId, all(), ids.badTruck))?.photos).toHaveLength(1);
    const theirs = await db.select({ id: checkins.id }).from(checkins).where(eq(checkins.operatorId, (await db.select().from(checkins)).at(-1)!.operatorId));
    expect(await checklistResultById(db, orgId, all(), theirs[0].id)).toBeNull();
  });

  it("CSV: one row per answer, plus general notes and covered check-ins", async () => {
    const { rows } = await query({ covered: "1" });
    const csv = resultsCsvRows(rows, TZ, new Map([[ids.badTruck, at(4)]]));
    expect(csv[0]).toEqual(["Date", "Time", "Unit", "Machine", "Operator", "Checklist", "Result", "Section", "Question", "Answer", "Defect", "Note", "Photos", "At machine", "Check-in ID"]);
    const bob = csv.filter((r) => r[14] === ids.badTruck);
    expect(bob).toHaveLength(2);
    expect(bob[0].slice(2, 13)).toEqual(["14", "Truck", "Bob", "Daily", "Defects", "Walk-around", "Tires", "Major defect", "Major", "Flat front left", 1]);
    expect(bob[1].slice(8, 12)).toEqual(["General notes", "", "", "Needs a tire"]);
    expect(csv.find((r) => r[14] === ids.covered)?.slice(6, 12)).toEqual(["Done earlier today", "", "", "Covered by the checklist at 08:30", "", ""]);
    expect(csv.filter((r) => r[14] === ids.okLoader).map((r) => r[9])).toEqual(["OK", "12345"]);
  });
});
