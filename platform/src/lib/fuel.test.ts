import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, engineSessions, machines, organizations } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { checkFuelTheft, median } from "./fuel";

let db: Db;
let machineId: number;
const t0 = new Date("2026-10-20T21:00:00Z"); // 5 PM Toronto
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
/** A report while running (OBD RPM 900) with a fuel level, or a stopped report. */
const running = (fuel: number | null, min: number, field = "obdFuelLevelPct") =>
  ingestSamples(db, "DEV1", [{ obdRpm: 900, ...(fuel === null ? {} : { [field]: fuel }) }], { now: at(min) });
const stopped = (min: number) => ingestSamples(db, "DEV1", [{ obdRpm: 0 }], { now: at(min) });
/** Runs for a few minutes at `levels`, checking after each report. */
async function run(levels: number[], fromMin: number, field?: string) {
  const raised = [];
  for (let i = 0; i < levels.length; i++) {
    await running(levels[i], fromMin + i, field);
    raised.push(...(await checkFuelTheft(db, machineId, at(fromMin + i))));
  }
  return raised;
}

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Loader", unitNumber: "7", fuelTankLitres: 400 }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

describe("fuel theft", () => {
  it("takes the median, so one sloshing reading doesn't count", () => {
    expect(median([60, 61, 30, 60, 62])).toBe(60);
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("alerts when the tank is lower at the next start than at the last stop", async () => {
    expect(await run([70, 70, 69, 70, 70, 69], 0)).toEqual([]); // first start: nothing to compare with
    await stopped(10);
    const raised = await run([52, 52, 53, 52, 51, 52], 13 * 60); // next morning: 18% gone
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ type: "fuel-theft", title: "Possible fuel theft: Unit 7 · Loader" });
    expect(raised[0].detail).toMatch(/^The fuel level dropped from 70% to 52% \(about 72 L of the 400 L tank\) while the engine was off: stopped .*, started again .* \(12 h 5\d min later\)\. Check the tank and fuel cap\.$/);
    // Checked once per start.
    expect(await checkFuelTheft(db, machineId, at(13 * 60 + 10))).toEqual([]);
    const [session] = await db.select().from(engineSessions).where(eq(engineSessions.id, raised[0].engineSessionId!));
    expect(session.fuelStartPct).toBe(52);
  });

  it("ignores normal use, refuelling, small drops, and waits for the level to settle", async () => {
    await run([70, 70, 70, 70, 70], 0);
    await stopped(10);
    // Refuelled overnight.
    expect(await run([95, 95, 95, 95, 95], 600)).toEqual([]);
    await stopped(700);
    // 4% lower: within normal sensor and slope differences.
    expect(await run([91, 91, 91, 91, 91], 800)).toEqual([]);
    await stopped(900);
    // Too soon after the start: no decision yet.
    await running(60, 1000);
    expect(await checkFuelTheft(db, machineId, at(1001))).toEqual([]);
    expect((await db.select().from(engineSessions).orderBy(engineSessions.id)).at(-1)!.fuelCheckedAt).toBeNull();
  });

  it("needs at least 20 L when the tank size is known, and works from J1939 fuel level", async () => {
    await db.update(machines).set({ fuelTankLitres: 200 }).where(eq(machines.id, machineId));
    await run([50, 50, 50, 50, 50], 0, "j1939FuelLevelPct");
    await stopped(10);
    expect(await run([42, 42, 42, 42, 42], 600, "j1939FuelLevelPct")).toEqual([]); // 8% of 200 L = 16 L
    await stopped(700);
    expect(await run([30, 30, 30, 30, 30], 800, "j1939FuelLevelPct")).toHaveLength(1); // 12% = 24 L
  });

  it("gives up quietly on machines that don't report fuel level", async () => {
    for (let m = 0; m <= 16; m += 2) await running(null, m);
    expect(await checkFuelTheft(db, machineId, at(16))).toEqual([]);
    expect((await db.select().from(engineSessions))[0].fuelCheckedAt).toEqual(at(16));
  });
});
