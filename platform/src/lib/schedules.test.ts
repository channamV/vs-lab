import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, devices, divisions, machineModeChanges, machineOperators, machines, operators, organizations, schedules, userDivisions, users } from "@/lib/db/schema";
import type { AuthContext } from "@/lib/auth";
import { createMachine, pairDevice } from "@/lib/machines";
import { hashPin } from "@/lib/operators";
import { setMode } from "@/lib/modes";
import { currentMode } from "@/lib/mode-types";
import {
  checkLateChanges,
  createSchedule,
  deleteSchedule,
  runSchedules,
  scheduledAccess,
  ScheduleError,
  sendOverrideReminders,
  setScheduleStatus,
  updateSchedule,
  type ScheduleInput,
} from "./schedules";
import { describeSchedule, findConflicts, occurrences, resolveMachine, validateSchedule, zonedToUtc, type ScheduleSpec } from "./schedule-time";

const TZ = "America/Toronto";
/** Wall-clock Toronto time → Date. */
const local = (date: string, time: string) => new Date(zonedToUtc(date, time, TZ));

const base: ScheduleInput = {
  name: "Weeknight lockdown",
  status: "active",
  action: "machine_mode",
  mode: "locked",
  machineIds: [],
  operatorIds: [],
  recurrence: "weekly",
  timezone: TZ,
  startDate: null,
  startTime: "18:00",
  endDate: null,
  endTime: "06:00",
  noEnd: false,
  weekdays: [1, 2, 3, 4, 5],
  allDay: false,
  effectiveFrom: null,
  effectiveUntil: null,
  endBehavior: "revert",
  endMode: null,
  remindBeforeExpiry: false,
};
const spec = (extra: Partial<ScheduleSpec>): ScheduleSpec => ({ ...base, id: 1, ...extra });

describe("time windows", () => {
  it("keeps 6 PM local across the daylight-saving change, overnight to the next morning", () => {
    // Toronto falls back on Sunday 1 Nov 2026.
    const list = occurrences(spec({}), local("2026-10-30", "12:00").getTime(), 6);
    expect(list.map((o) => [new Date(o.start).toISOString(), new Date(o.end!).toISOString()])).toEqual([
      ["2026-10-30T22:00:00.000Z", "2026-10-31T10:00:00.000Z"], // Fri 6 PM EDT → Sat 6 AM EDT
      ["2026-11-02T23:00:00.000Z", "2026-11-03T11:00:00.000Z"], // Mon 6 PM EST → Tue 6 AM EST
      ["2026-11-03T23:00:00.000Z", "2026-11-04T11:00:00.000Z"],
      ["2026-11-04T23:00:00.000Z", "2026-11-05T11:00:00.000Z"],
    ]);
  });

  it("joins all-day weekend days into one window and respects the date range", () => {
    const weekend = spec({ weekdays: [0, 6], allDay: true, startTime: null, endTime: null, effectiveUntil: "2026-11-01" });
    const list = occurrences(weekend, local("2026-10-26", "00:00").getTime(), 14);
    expect(list).toEqual([{ start: local("2026-10-31", "00:00").getTime(), end: local("2026-11-02", "00:00").getTime() }]);
  });

  it("explains the schedule in plain English", () => {
    const names = { machines: new Map([[7, "Loader"]]), operators: new Map([[3, "Jane Smith"]]), allMachines: [7] };
    expect(describeSchedule(spec({}), names)).toEqual([
      "Every weekday (Mon–Fri) from 6:00 PM to 6:00 AM the next morning, all machines will be set to Locked.",
      "At 6:00 AM, they return to the mode they were in before (unless another schedule applies).",
      "This repeats with no end date.",
    ]);
    const access = spec({ action: "operator_access", mode: null, machineIds: [7], operatorIds: [3], weekdays: [6], startTime: "07:00", endTime: "15:00" });
    expect(describeSchedule(access, names)[0]).toBe("Jane Smith will be able to start Loader every Saturday from 7:00 AM to 3:00 PM, with no end date.");
  });

  it("checks what's needed before saving", () => {
    const now = local("2026-10-22", "12:00").getTime();
    expect(validateSchedule(spec({}), now)).toEqual([]);
    expect(validateSchedule(spec({ weekdays: [], startTime: "18:00", endTime: "18:00" }), now)).toEqual([
      "Select at least one day of the week.",
      "Start and end times can't be the same. Use All day for a 24-hour window.",
    ]);
    expect(validateSchedule(spec({ recurrence: "once", startDate: "2026-10-20", startTime: "08:00", endDate: "2026-10-21", endTime: "08:00" }), now)).toEqual([
      "The end time is already in the past.",
    ]);
    expect(validateSchedule(spec({ endBehavior: "set_mode", endMode: "locked" }), now)[0]).toMatch(/same as the scheduled mode/);
  });
});

describe("resolving overlaps", () => {
  const at = local("2026-10-27", "20:00").getTime(); // Tuesday evening
  const lock = spec({ id: 1 });
  const unlock = spec({ id: 2, name: "Night shift", mode: "unlocked", startTime: "19:00", endTime: "23:00" });
  it("least restrictive wins by default; most restrictive when the company chooses it", () => {
    expect(resolveMachine(7, [lock, unlock], [7], "least_restrictive", at)).toEqual({ mode: "unlocked", scheduleId: 2 });
    expect(resolveMachine(7, [lock, unlock], [7], "most_restrictive", at)).toEqual({ mode: "locked", scheduleId: 1 });
  });
  it("an override beats regular schedules", () => {
    const override = spec({ id: 3, recurrence: "override", mode: "locked", startDate: "2026-10-27", startTime: "19:30", endDate: "2026-10-27", endTime: "21:00" });
    expect(resolveMachine(7, [lock, unlock, override], [7], "least_restrictive", at)).toEqual({ mode: "locked", scheduleId: 3 });
  });
  it("scheduled operator access turns a scheduled Locked into Access-Controlled", () => {
    const access = spec({ id: 4, action: "operator_access", mode: null, machineIds: [7], operatorIds: [3], startTime: "19:00", endTime: "21:00" });
    expect(resolveMachine(7, [lock, access], [7], "least_restrictive", at)).toEqual({ mode: "access_controlled", scheduleId: 4 });
  });
  it("skips a window that was running when a manager changed the mode by hand", () => {
    expect(resolveMachine(7, [lock], [7], "least_restrictive", at, local("2026-10-27", "19:00").getTime())).toBeNull();
  });
  it("lists conflicts with the rule's outcome", () => {
    const names = { machines: new Map([[7, "Loader"]]), operators: new Map(), allMachines: [7] };
    const [c] = findConflicts(unlock, [lock], names, "least_restrictive", local("2026-10-26", "12:00").getTime());
    expect(c).toMatchObject({ severity: "conflict", otherName: "Weeknight lockdown" });
    expect(c.resolution).toBe("If both stay active, the least restrictive mode applies so work isn't blocked: Unlocked.");
  });
});

describe("running schedules", () => {
  let db: Db;
  let org: number;
  let machineId: number;
  let auth: AuthContext;
  const machine = async () => (await db.select().from(machines).where(eq(machines.id, machineId)))[0];

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
    ({ id: machineId } = await createMachine(db, org, { name: "Loader", unitNumber: "7", tier: "monitor" }));
    const [u] = await db.insert(users).values({ organizationId: org, email: "pat@abc.com", role: "manager" }).returning();
    auth = { sessionId: 1, userId: u.id, email: u.email, name: null, role: "manager", isPlatformAdmin: false, homeOrganizationId: org, organizationId: org, organizationName: "ABC", divisionIds: null };
  });

  it("locks at 6 PM and returns to the earlier mode at 6 AM, with the schedule in the history", async () => {
    await createSchedule(db, auth, base, local("2026-10-27", "12:00"));
    await runSchedules(db, local("2026-10-27", "17:59"));
    expect((await machine()).mode).toBe("access_controlled");
    await runSchedules(db, local("2026-10-27", "18:00"));
    expect(await machine()).toMatchObject({ mode: "locked", modeSource: "schedule", modeBeforeSchedule: "access_controlled" });
    await runSchedules(db, local("2026-10-28", "06:00"));
    expect(await machine()).toMatchObject({ mode: "access_controlled", scheduleId: null });
    const history = await db.select().from(machineModeChanges).orderBy(machineModeChanges.id);
    expect(history.map((h) => [h.mode, h.changedBy])).toEqual([
      ["locked", "Schedule “Weeknight lockdown”"],
      ["access_controlled", "Schedule “Weeknight lockdown”"],
    ]);
  });

  it("a manager's change during a window stands until the next window", async () => {
    await createSchedule(db, auth, base, local("2026-10-27", "12:00"));
    await runSchedules(db, local("2026-10-27", "18:00"));
    await setMode(db, org, machineId, { mode: "unlocked", reason: "late pour" }, "pat@abc.com", local("2026-10-27", "19:00"));
    await runSchedules(db, local("2026-10-27", "19:01"));
    expect((await machine()).mode).toBe("unlocked");
    await runSchedules(db, local("2026-10-28", "06:00"));
    expect((await machine()).mode).toBe("unlocked"); // nothing to revert: the manager took over
    await runSchedules(db, local("2026-10-28", "18:00"));
    expect((await machine()).mode).toBe("locked");
  });

  it("can set a specific mode at the end", async () => {
    await createSchedule(
      db,
      auth,
      { ...base, name: "Service", recurrence: "once", weekdays: [], startDate: "2026-10-27", startTime: "07:00", endDate: "2026-10-27", endTime: "17:00", endBehavior: "set_mode", endMode: "unlocked" },
      local("2026-10-27", "06:00"),
    );
    await runSchedules(db, local("2026-10-27", "07:00"));
    expect((await machine()).mode).toBe("locked");
    await runSchedules(db, local("2026-10-27", "17:00"));
    expect((await machine()).mode).toBe("unlocked");
  });

  it("deleting a schedule in effect applies its end behaviour; pausing keeps the mode", async () => {
    const s = await createSchedule(db, auth, base, local("2026-10-27", "18:30"));
    expect((await machine()).mode).toBe("locked"); // applied straight away (already in its window)
    await deleteSchedule(db, auth, s.id, local("2026-10-27", "19:00"));
    expect((await machine()).mode).toBe("access_controlled");

    const p = await createSchedule(db, auth, base, local("2026-10-27", "19:30"));
    await setScheduleStatus(db, auth, p.id, "paused", local("2026-10-27", "20:00"));
    await runSchedules(db, local("2026-10-28", "06:00"));
    expect((await machine()).mode).toBe("locked"); // pausing stops future changes, it doesn't undo
    await runSchedules(db, local("2026-10-28", "18:00"));
    expect((await machine()).mode).toBe("locked");
  });

  it("checks permissions when saving and again when running", async () => {
    await expect(createSchedule(db, { ...auth, role: "viewer" }, base, local("2026-10-27", "12:00"))).rejects.toThrow(ScheduleError);
    // Limited to a division: can't schedule "all machines", or machines outside it.
    const [d] = await db.insert(divisions).values({ organizationId: org, name: "North" }).returning();
    const limited = { ...auth, divisionIds: [d.id] };
    await expect(createSchedule(db, limited, base, local("2026-10-27", "12:00"))).rejects.toThrow(/your divisions/);
    await expect(createSchedule(db, limited, { ...base, machineIds: [machineId] }, local("2026-10-27", "12:00"))).rejects.toThrow(/not found/);
    // A schedule whose creator is no longer a manager doesn't run.
    await createSchedule(db, auth, base, local("2026-10-27", "12:00"));
    await db.update(users).set({ role: "viewer" }).where(eq(users.id, auth.userId));
    await runSchedules(db, local("2026-10-27", "18:00"));
    expect((await machine()).mode).toBe("access_controlled");
    // ...and a division-limited creator's schedule only reaches their machines.
    await db.update(users).set({ role: "manager" }).where(eq(users.id, auth.userId));
    await db.insert(userDivisions).values({ userId: auth.userId, divisionId: d.id });
    await runSchedules(db, local("2026-10-27", "18:01"));
    expect((await machine()).mode).toBe("access_controlled");
  });

  it("gives scheduled operators access, only during the window, without changing approvals", async () => {
    const [jane] = await db.insert(operators).values({ organizationId: org, name: "Jane", pinHash: hashPin("1234") }).returning();
    await createSchedule(
      db,
      auth,
      { ...base, name: "Sub crew", action: "operator_access", mode: null, machineIds: [machineId], operatorIds: [jane.id], weekdays: [2], startTime: "07:00", endTime: "15:00" },
      local("2026-10-26", "12:00"),
    );
    expect(await scheduledAccess(db, org, machineId, local("2026-10-27", "08:00"))).toEqual([jane.id]);
    expect(await scheduledAccess(db, org, machineId, local("2026-10-27", "16:00"))).toEqual([]);
    expect(await scheduledAccess(db, org, machineId, local("2026-10-28", "08:00"))).toEqual([]); // Wednesday
    expect(await db.select().from(machineOperators)).toEqual([]);
  });

  it("alerts when a relay machine hasn't confirmed a scheduled change", async () => {
    await db.update(machines).set({ tier: "control" });
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", machineId, local("2026-10-27", "08:00"));
    await createSchedule(db, auth, base, local("2026-10-27", "12:00"));
    await runSchedules(db, local("2026-10-27", "18:00"));
    expect(await checkLateChanges(db, local("2026-10-27", "18:05"))).toEqual([]);
    const [late] = await checkLateChanges(db, local("2026-10-27", "18:11"));
    expect(late).toMatchObject({ type: "schedule-late", title: "Scheduled change is late: Unit 7 · Loader" });
    expect(await checkLateChanges(db, local("2026-10-27", "18:20"))).toEqual([]); // once per change
    expect(await db.select().from(alerts)).toHaveLength(1);
  });

  it("reminds once before an override ends", async () => {
    const s = await createSchedule(
      db,
      auth,
      { ...base, name: "Hold", recurrence: "override", weekdays: [], startDate: "2026-10-27", startTime: "08:00", endDate: "2026-10-27", endTime: "12:00", remindBeforeExpiry: true },
      local("2026-10-27", "08:00"),
    );
    expect(await sendOverrideReminders(db, local("2026-10-27", "11:30"))).toBe(0);
    expect(await sendOverrideReminders(db, local("2026-10-27", "11:46"))).toBe(1);
    expect(await sendOverrideReminders(db, local("2026-10-27", "11:50"))).toBe(0);
    const [row] = await db.select().from(schedules).where(eq(schedules.id, s.id));
    expect(row.reminderSentFor).toEqual(local("2026-10-27", "12:00"));
  });

  it("editing applies straight away; GPS machines get Unlocked instead of Access-Controlled", async () => {
    await db.update(machines).set({ tier: "gps", mode: "locked" });
    const s = await createSchedule(db, auth, { ...base, mode: "access_controlled" }, local("2026-10-27", "19:00"));
    expect(currentMode(await machine())).toBe("unlocked");
    await updateSchedule(db, auth, s.id, { ...base, mode: "locked" }, local("2026-10-27", "19:05"));
    expect((await machine()).mode).toBe("locked");
  });
});
