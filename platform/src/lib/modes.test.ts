import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceCommands, devices, machines, notificationEvents, operators, organizations } from "@/lib/db/schema";
import { recordAnswer, commandsForReply } from "@/lib/commands";
import { createMachine, pairDevice } from "@/lib/machines";
import { checkIn, hashPin } from "@/lib/operators";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { applyModeTimers, checkLockedUse, confirmMode, durationEnd, effectiveMode, ModeError, setMode, setOfflineFallback } from "./modes";
import { currentMode } from "./mode-types";

let db: Db;
let org: number;
let machineId: number;
const t0 = new Date("2026-10-22T14:00:00Z"); // 10 AM Toronto
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const here = { lat: 43.653, lng: -79.383, satellites: 9 };
const report = (min: number, fields: Record<string, number>) => ingestSamples(db, "DEV1", [fields], { now: at(min) });
const machine = async () => (await db.select().from(machines).where(eq(machines.id, machineId)))[0];

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org, { name: "Loader", unitNumber: "7", tier: "monitor" }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

describe("changing modes", () => {
  it("starts Access-Controlled; GPS machines behave as Unlocked", async () => {
    const m = await machine();
    expect(currentMode(m)).toBe("access_controlled");
    expect(currentMode({ ...m, tier: "gps" })).toBe("unlocked");
  });

  it("records the change and a notification event", async () => {
    await setMode(db, org, machineId, { mode: "locked", reason: "Weekend" }, "pat@abc.com", t0);
    const m = await machine();
    expect(m).toMatchObject({ mode: "locked", modeReason: "Weekend", modeChangedBy: "pat@abc.com", modeSource: "manager", modeUntil: null });
    const [event] = await db.select().from(notificationEvents).where(eq(notificationEvents.type, "mode_changed"));
    expect(event.detail).toBe("Access-Controlled → Locked (Weekend) by pat@abc.com.");
  });

  it("a timed change goes back to the earlier mode", async () => {
    await setMode(db, org, machineId, { mode: "unlocked", until: at(240) }, "pat", t0);
    let m = await machine();
    expect(currentMode(m, at(100).getTime())).toBe("unlocked");
    expect(currentMode(m, at(241).getTime())).toBe("access_controlled"); // even before the timer job runs
    // Changing again for a while still returns to the original mode.
    await setMode(db, org, machineId, { mode: "locked", until: at(60) }, "pat", at(10));
    expect((await machine()).modeRevertTo).toBe("access_controlled");
    expect(await applyModeTimers(db, at(30))).toEqual([]);
    expect(await applyModeTimers(db, at(61))).toHaveLength(1);
    m = await machine();
    expect(m).toMatchObject({ mode: "access_controlled", modeUntil: null, modeSource: "timer" });
  });

  it("only offers the tier's modes and future times", async () => {
    await db.update(machines).set({ tier: "gps" });
    await expect(setMode(db, org, machineId, { mode: "access_controlled" }, "pat", t0)).rejects.toThrow(ModeError);
    await expect(setMode(db, org, machineId, { mode: "locked", until: at(-1) }, "pat", t0)).rejects.toThrow(/future/);
    await expect(setMode(db, org + 1, machineId, { mode: "locked" }, "pat", t0)).rejects.toThrow(/not found/);
    expect(() => durationEnd("until", t0, null)).toThrow(ModeError);
    expect(durationEnd("4h", t0)).toEqual(at(240));
    expect(durationEnd("morning", t0)!.toISOString()).toBe("2026-10-23T10:00:00.000Z"); // 6 AM Toronto
  });

  it("the checklist safety lock always counts as Locked", async () => {
    await db.update(machines).set({ mode: "unlocked", lockedOutAt: t0 });
    expect(effectiveMode(await machine())).toEqual({ mode: "locked", safety: true });
  });
});

describe("Locked machines", () => {
  beforeEach(async () => {
    await report(0, { ...here, obdRpm: 0 });
    await setMode(db, org, machineId, { mode: "locked" }, "pat", at(1));
  });

  it("alert once when started", async () => {
    await report(5, { ...here, obdRpm: 900 });
    const raised = await checkLockedUse(db, machineId, at(5));
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: "locked-use", title: "Started while Locked: Unit 7 · Loader" });
    await report(6, { ...here, obdRpm: 900 });
    expect(await checkLockedUse(db, machineId, at(6))).toEqual([]);
  });

  it("alert once when moved, even with the engine off (towed)", async () => {
    await report(10, { lat: 43.6534, lng: -79.383, satellites: 9, obdRpm: 0 }); // ~45 m: GPS wobble
    expect(await checkLockedUse(db, machineId, at(10))).toEqual([]);
    await report(20, { lat: 43.66, lng: -79.383, satellites: 9, obdRpm: 0 }); // ~780 m
    const raised = await checkLockedUse(db, machineId, at(20));
    expect(raised).toHaveLength(1);
    expect(raised[0].detail).toMatch(/^The machine is 7\d\d m from where it was when it was locked, with the engine off \(towed or carried\?\)/);
    expect(await checkLockedUse(db, machineId, at(21))).toEqual([]);
  });

  it("refuse check-ins", async () => {
    await db.insert(operators).values({ organizationId: org, name: "Jane", pinHash: hashPin("1234") });
    const m = await machine();
    const result = await checkIn(db, { machineCode: m.code, pin: "1234", answers: {}, notes: "", confirmed: true }, at(5));
    expect(result).toEqual({ ok: false, reason: "machine-locked" });
  });

  it("nothing when Unlocked again", async () => {
    await setMode(db, org, machineId, { mode: "unlocked" }, "pat", at(2));
    await report(5, { lat: 43.66, lng: -79.383, satellites: 9, obdRpm: 900 });
    expect(await checkLockedUse(db, machineId, at(5))).toEqual([]);
  });
});

describe("relay machines (Safety & Access Control)", () => {
  beforeEach(async () => {
    await db.update(machines).set({ tier: "control" });
  });

  it("send the mode and offline fallback to the device, which confirms", async () => {
    await setOfflineFallback(db, org, machineId, "unlocked", 8, "pat", t0);
    await setMode(db, org, machineId, { mode: "locked" }, "pat", t0);
    const open = await db.select().from(deviceCommands).where(eq(deviceCommands.status, "pending"));
    expect(open.map((c) => c.command)).toEqual(["MODE=locked\tunlocked\t8"]); // the earlier MODE command was replaced
    const [line] = await commandsForReply(db, "DEV1", t0);
    expect(line).toMatch(/^CMD \d+ - MODE=locked\tunlocked\t8$/);
    const answered = await recordAnswer(db, "DEV1", { id: open[0].id, ok: true, result: "enforcing locked", sig: null });
    await confirmMode(db, "DEV1", answered.command, answered.status === "done");
    expect(await machine()).toMatchObject({ confirmedMode: "locked" });
  });

  it("check the offline fallback", async () => {
    await expect(setOfflineFallback(db, org, machineId, "sideways", 8, "pat")).rejects.toThrow(ModeError);
    await expect(setOfflineFallback(db, org, machineId, null, 0, "pat")).rejects.toThrow(/between/);
    await setOfflineFallback(db, org, machineId, null, 24, "pat");
    expect(await machine()).toMatchObject({ offlineMode: null, offlineAfterHours: 24 });
  });

  it("don't send anything for machines without a relay", async () => {
    await db.update(machines).set({ tier: "monitor" });
    await setMode(db, org, machineId, { mode: "locked" }, "pat", t0);
    expect(await db.select().from(deviceCommands)).toEqual([]);
  });
});
