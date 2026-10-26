import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, engineSessions, machines, maintenanceActivity, maintenanceIssues, maintenanceSchedules, notificationEvents, organizations, users } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { currentReadings, parseReading, recordReading } from "@/lib/meters";
import { placeFromAddress, placeName } from "@/lib/places";
import {
  addReading,
  checkConnectivity,
  checkSchedules,
  createManualIssue,
  createSchedule,
  defectPriority,
  openServiceNow,
  recordChecklistDefects,
  resolveIssue,
  updateIssue,
} from "./maintenance";
import { describeDuePart, describeInterval, dueState, missingForResolve, nextDueFrom, topPriority } from "./maintenance-types";

const T0 = Date.parse("2026-10-26T12:00:00Z");
const at = (h: number) => new Date(T0 + h * 3_600_000);

describe("due rules (pure)", () => {
  const s = { everyDays: 30, everyHours: 250, everyKm: null, nextDueOn: "2026-11-20", nextDueHours: 1250, nextDueKm: null };
  it("is due when any limit is reached, due soon in the last 10%", () => {
    expect(dueState(s, "2026-10-26", { hours: 1000, km: null })).toMatchObject({ state: "ok" });
    expect(dueState(s, "2026-10-26", { hours: 1230, km: null })).toMatchObject({ state: "soon" });
    expect(dueState(s, "2026-11-18", { hours: 1000, km: null })).toMatchObject({ state: "soon" });
    expect(dueState(s, "2026-11-21", { hours: 1000, km: null }).state).toBe("due");
    expect(dueState(s, "2026-10-26", { hours: 1260, km: null }).parts.map(describeDuePart)).toEqual(["in 25 days", "10 h overdue"]);
    // Counting hours only, with no reading yet: unknown.
    expect(dueState({ ...s, everyDays: null, nextDueOn: null }, "2026-10-26", { hours: null, km: null }).state).toBe("unknown");
  });
  it("works out the next due from a service and describes intervals", () => {
    expect(nextDueFrom({ everyDays: 182, everyHours: 500, everyKm: 10000 }, { on: "2026-10-26", hours: 1234.56, km: null })).toEqual({
      nextDueOn: "2027-04-26",
      nextDueHours: 1734.6,
      nextDueKm: null,
    });
    expect(describeInterval({ everyDays: 180, everyHours: 250, everyKm: null })).toBe("Every 250 h or 6 mo");
    expect(missingForResolve({ complaint: "Leak", cause: " ", correction: null })).toEqual(["Cause", "Correction"]);
    expect(topPriority(["minor", "lockout", "low"])).toBe("lockout");
    expect(defectPriority("major", true)).toBe("lockout");
    expect(defectPriority("minor", true)).toBe("minor");
  });
});

describe("readings and places (pure)", () => {
  it("parses readings", () => {
    expect(parseReading(" 12,345.67 ")).toBe(12345.7);
    expect(parseReading("")).toBeNull();
    expect(parseReading("abc")).toEqual({ error: expect.any(String) });
  });
  it("names the town and province", () => {
    expect(placeFromAddress({ city: "Mount Pearl", state: "Newfoundland and Labrador", "ISO3166-2-lvl4": "CA-NL" })).toBe("Mount Pearl, NL");
    expect(placeFromAddress({ village: "Whitbourne", "ISO3166-2-lvl4": "CA-NL" })).toBe("Whitbourne, NL");
    expect(placeFromAddress({ town: "Galway", state: "Connacht" })).toBe("Galway, Connacht");
    expect(placeFromAddress(undefined)).toBeNull();
  });
});

describe("maintenance", () => {
  let db: Db;
  let org: number;
  let machineId: number;
  let userId: number;
  const issues = () => db.select().from(maintenanceIssues).orderBy(maintenanceIssues.id);

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC", timezone: "America/St_Johns" }).returning();
    ({ id: machineId } = await createMachine(db, org, { name: "Loader", tier: "monitor" }));
    [{ id: userId }] = await db.insert(users).values({ organizationId: org, email: "mech@abc.com", role: "manager" }).returning();
  });

  it("estimates hours from the last reading plus measured engine time; the engine's own meter wins", async () => {
    await recordReading(db, { organizationId: org, machineId, kind: "hours", value: 1000, source: "manual" }, at(0));
    await db.insert(engineSessions).values([
      { machineId, startedAt: at(1), endedAt: at(3), lastSeenAt: at(3) },
      { machineId, startedAt: at(-5), endedAt: at(-4), lastSeenAt: at(-4) }, // before the reading: not counted
    ]);
    expect((await currentReadings(db, [machineId], at(5))).get(machineId)?.hours).toMatchObject({ value: 1002, source: "estimated" });
    await db.update(machines).set({ engineHourMeter: 4321.25, engineHourMeterAt: at(4) }).where(eq(machines.id, machineId));
    expect((await currentReadings(db, [machineId], at(5))).get(machineId)?.hours).toMatchObject({ value: 4321.3, source: "engine" });
  });

  it("adds a repeat checklist report to the open item; a resolved one starts a new item", async () => {
    const defect = { questionId: "glass", question: "Windows not cracked", section: "Cab", severity: "minor" as const, answerLabel: "Repair needed", note: "Cracked rear glass" };
    await recordChecklistDefects(db, { organizationId: org, machineId, checkinId: null as unknown as number, defects: [defect], lockout: false, now: at(0) });
    await recordChecklistDefects(db, { organizationId: org, machineId, checkinId: null as unknown as number, defects: [{ ...defect, note: "Worse" }], lockout: false, now: at(24) });
    let [item] = await issues();
    expect(item).toMatchObject({ number: 1001, reportCount: 2, priority: "minor", note: "Worse", status: "new" });
    await updateIssue(db, org, item.id, userId, { cause: "Rock strike", correction: "Replaced rear glass", status: "resolved" }, at(30));
    await recordChecklistDefects(db, { organizationId: org, machineId, checkinId: null as unknown as number, defects: [defect], lockout: false, now: at(48) });
    const all = await issues();
    expect(all.map((i) => [i.number, i.status, i.reportCount])).toEqual([
      [1001, "resolved", 2],
      [1002, "new", 1],
    ]);
    // A resolved item can't be reopened while a newer one is open for the same thing.
    await expect(updateIssue(db, org, all[0].id, userId, { status: "in_progress" }, at(49))).rejects.toThrow("#1002 is already open");
    [item] = all;
    const log = await db.select().from(maintenanceActivity).where(eq(maintenanceActivity.issueId, item.id)).orderBy(maintenanceActivity.id);
    expect(log.map((l) => l.kind)).toEqual(["created", "reported_again", "edited", "resolved"]);
  });

  it("resolving the last locked-out item clears the machine's repair lockout", async () => {
    await db.update(machines).set({ lockedOutAt: at(0), lockedOutReason: "Brakes" }).where(eq(machines.id, machineId));
    const defect = { questionId: "brakes", question: "Brakes", section: "Walk-around", severity: "major" as const, answerLabel: "Major defect", note: "Soft pedal" };
    await recordChecklistDefects(db, { organizationId: org, machineId, checkinId: null as unknown as number, defects: [defect], lockout: true, now: at(0) });
    const [item] = await issues();
    expect(item.priority).toBe("lockout");
    await expect(resolveIssue(db, org, item.id, userId, at(1))).rejects.toThrow("Fill in Cause, Correction");
    await updateIssue(db, org, item.id, userId, { cause: "Air in lines", correction: "Bled the brakes", status: "resolved" }, at(2));
    expect((await db.select().from(machines))[0].lockedOutAt).toBeNull();
  });

  it("opens a service item when a schedule comes due, once, and moves the schedule on when it's done", async () => {
    await recordReading(db, { organizationId: org, machineId, kind: "hours", value: 980, source: "manual" }, at(0));
    const schedule = await createSchedule(db, org, userId, { machineId, description: "250-hour service", everyHours: "250", lastDoneHours: "750" }, at(0));
    expect(schedule).toMatchObject({ nextDueHours: 1000, nextDueOn: null });
    expect(await checkSchedules(db, at(1))).toEqual([]);
    await addReading(db, org, machineId, userId, "hours", "1003", at(2));
    expect(await checkSchedules(db, at(3))).toEqual([]); // already opened by the reading
    const [item] = await issues();
    expect(item).toMatchObject({ source: "schedule", priority: "overdue_pm", title: "Service due: 250-hour service", scheduleId: schedule.id });
    expect(item.complaint).toContain("3 h overdue");
    expect((await db.select().from(notificationEvents)).map((e) => e.type)).toEqual(["service_due"]);
    // Opening it by hand returns the same item.
    expect((await openServiceNow(db, org, schedule.id, userId, at(3))).created).toBe(false);

    await updateIssue(db, org, item.id, userId, { cause: "Due", correction: "Oil, filters, grease", servicedHours: "1005", status: "resolved" }, at(4));
    const [after] = await db.select().from(maintenanceSchedules);
    expect(after).toMatchObject({ nextDueHours: 1255 });
    expect(after.lastServicedAt).toEqual(at(4));
    expect((await issues())[0]).toMatchObject({ servicedHours: 1005, servicedOn: "2026-10-26" });
  });

  it("opens an item for a device offline 72 h and closes it when it reports again", async () => {
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", machineId, at(-100));
    await db.update(machines).set({ lastSeenAt: at(-80) }).where(eq(machines.id, machineId));
    expect(await checkConnectivity(db, at(0))).toEqual({ opened: 1, closed: 0 });
    expect(await checkConnectivity(db, at(1))).toEqual({ opened: 0, closed: 0 });
    await db.update(machines).set({ lastSeenAt: at(2) }).where(eq(machines.id, machineId));
    expect(await checkConnectivity(db, at(2))).toEqual({ opened: 0, closed: 1 });
    expect((await issues())[0]).toMatchObject({ source: "connectivity", status: "resolved" });
  });

  it("staff add items with their own numbers per company", async () => {
    const a = await createManualIssue(db, org, userId, { machineId, title: "Hydraulic leak", priority: "major", complaint: "Drip under boom" }, at(0));
    const [{ id: other }] = await db.insert(organizations).values({ name: "Other" }).returning();
    const { id: theirMachine } = await createMachine(db, other, { name: "Truck", tier: "gps" });
    const b = await createManualIssue(db, other, null, { machineId: theirMachine, title: "Tire", priority: "low", complaint: "" }, at(0));
    expect([a.number, b.number]).toEqual([1001, 1001]);
    await expect(createManualIssue(db, org, userId, { machineId: theirMachine, title: "x", priority: "low", complaint: "" })).rejects.toThrow("Choose a machine");
    await expect(updateIssue(db, other, a.id, null, { cause: "x" })).rejects.toThrow("doesn't exist");
  });

  it("looks up and caches place names", async () => {
    let calls = 0;
    const fake = (async () => {
      calls++;
      return new Response(JSON.stringify({ address: { town: "Paradise", "ISO3166-2-lvl4": "CA-NL" } }));
    }) as unknown as typeof fetch;
    expect(await placeName(db, 47.5301, -52.8702, at(0), fake)).toBe("Paradise, NL");
    expect(await placeName(db, 47.5299, -52.8698, at(1), fake)).toBe("Paradise, NL");
    expect(calls).toBe(1);
  });
});
