import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { deviceCommands, devices, machines, organizations } from "@/lib/db/schema";
import { DEFAULT_SECTIONS, ensureChecklistDefaults } from "@/lib/checklists";
import { createMachine, pairDevice } from "@/lib/machines";
import { checkIn, createOperator } from "@/lib/operators";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { desiredAlert, syncOperatorAlert } from "./operator-alerts";

describe("desiredAlert", () => {
  const base = { tier: "monitor", mode: "access_controlled", engineRunning: true };
  it("asks for a check-in, then a checklist, only while running and Access-Controlled", () => {
    expect(desiredAlert({ ...base, checkin: null })).toBe("not_checked_in");
    expect(desiredAlert({ ...base, checkin: { answers: 0, coveredBy: null } })).toBe("checklist_due"); // e.g. a beacon check-in
    expect(desiredAlert({ ...base, checkin: { answers: 0, coveredBy: 12 } })).toBe("none"); // today's checklist covers it
    expect(desiredAlert({ ...base, checkin: { answers: 10, coveredBy: null } })).toBe("none");
    expect(desiredAlert({ ...base, engineRunning: false, checkin: null })).toBe("none");
    expect(desiredAlert({ ...base, mode: "unlocked", checkin: null })).toBe("none");
    expect(desiredAlert({ ...base, tier: "gps", checkin: null })).toBe("none");
  });
});

describe("syncOperatorAlert", () => {
  let db: Db;
  let machineId: number;
  const t0 = Date.parse("2026-10-25T15:00:00Z");
  const at = (min: number) => new Date(t0 + min * 60_000);
  const commands = () => db.select().from(deviceCommands).orderBy(deviceCommands.id);

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
    ({ id: machineId } = await createMachine(db, org.id, { name: "Loader", tier: "monitor" }));
    await db.update(machines).set({ code: "LDR1" }).where(eq(machines.id, machineId));
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", machineId, at(-10));
    await ensureChecklistDefaults(db, org.id);
    await createOperator(db, org.id, { name: "Jane", pin: "1111" });
  });

  it("tells the device once when nobody is checked in, and stops when someone checks in", async () => {
    await ingestSamples(db, "DEV1", [{ deviceMs: 1000, batteryCentivolts: 1420 }], { now: at(0) });
    expect(await syncOperatorAlert(db, machineId, at(0))).toBe("not_checked_in");
    expect(await syncOperatorAlert(db, machineId, at(0.5))).toBe("not_checked_in");
    expect((await commands()).map((c) => [c.command, c.status])).toEqual([["ALERT=not_checked_in", "pending"]]);

    const answers = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));
    expect(await checkIn(db, { machineCode: "LDR1", pin: "1111", answers, confirmed: true }, at(1))).toMatchObject({ ok: true });
    expect(await syncOperatorAlert(db, machineId, at(1))).toBe("none");
    // The unanswered older alert is replaced.
    expect((await commands()).map((c) => [c.command, c.status])).toEqual([
      ["ALERT=not_checked_in", "cancelled"],
      ["ALERT=none", "pending"],
    ]);
  });

  it("stays quiet when the machine is Unlocked", async () => {
    await db.update(machines).set({ mode: "unlocked" }).where(eq(machines.id, machineId));
    await ingestSamples(db, "DEV1", [{ deviceMs: 1000, batteryCentivolts: 1420 }], { now: at(0) });
    expect(await syncOperatorAlert(db, machineId, at(0))).toBe("none");
    expect(await commands()).toHaveLength(0);
  });
});
