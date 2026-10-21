import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, engineSessions, machineFaults, machines, notificationEvents, organizations } from "@/lib/db/schema";
import { encodePayload, parsePayload } from "@/lib/freematics/protocol";
import { createMachine, pairDevice } from "@/lib/machines";
import { ingestSamples } from "@/lib/telemetry/ingest";
import { describeFault, encodeFault, lampsText } from "./j1939";

let db: Db;
let machineId: number;
const t0 = new Date("2026-10-21T14:00:00Z");
const at = (min: number) => new Date(t0.getTime() + min * 60_000);
const coolantHot = encodeFault({ spn: 110, fmi: 0 });
const waterInFuel = encodeFault({ spn: 97, fmi: 15 });
const send = (fields: Record<string, number | number[]>, min: number) => ingestSamples(db, "DEV1", [{ batteryCentivolts: 2790, ...fields }], { now: at(min) });
const faults = () => db.select().from(machineFaults).orderBy(machineFaults.id);
const faultEvents = async () => (await db.select().from(notificationEvents)).filter((e) => e.type === "engine_fault");

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  const [org] = await db.insert(organizations).values({ name: "ABC" }).returning();
  ({ id: machineId } = await createMachine(db, org.id, { name: "Dozer", unitNumber: "9" }));
  await db.insert(devices).values({ id: "DEV1" });
  await pairDevice(db, "DEV1", machineId, at(-60));
});

describe("J1939 wire format", () => {
  it("names our J1939 PIDs and round-trips fault lists", () => {
    const body = encodePayload([{ deviceMs: 1, j1939EngineHours: 1234.55, j1939Rpm: 1650, j1939Faults: [coolantHot, waterInFuel], j1939Lamps: 6 }]);
    expect(body).toMatch(/^0:1,301:1234\.55,305:1650,310:3520;3119,311:6\*/);
    expect(parsePayload(body).samples[0]).toEqual({ deviceMs: 1, j1939EngineHours: 1234.55, j1939Rpm: 1650, j1939Faults: [3520, 3119], j1939Lamps: 6 });
  });

  it("describes fault codes and lamps in plain words", () => {
    expect(describeFault({ spn: 110, fmi: 0 })).toBe("Engine coolant temperature: above normal (most severe) · SPN 110 FMI 0");
    expect(describeFault({ spn: 99999, fmi: 25 })).toBe("SPN 99999: FMI 25 · SPN 99999 FMI 25");
    expect(lampsText(6)).toBe("red stop lamp, amber warning lamp");
    expect(lampsText(0)).toBeNull();
  });
});

describe("engine data", () => {
  it("uses J1939 RPM for engine on/off and keeps the hour meter", async () => {
    await send({ j1939Rpm: 800, j1939EngineHours: 1500.25 }, 0);
    expect(await db.select().from(engineSessions)).toHaveLength(1);
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m).toMatchObject({ engineHourMeter: 1500.25, engineHourMeterAt: at(0), engineOn: true });
    await send({ j1939Rpm: 0 }, 5);
    expect((await db.select().from(machines).where(eq(machines.id, machineId)))[0].engineOn).toBe(false);
  });

  it("opens a fault when it appears (once), keeps it while reported, and clears it when it stops", async () => {
    await send({ j1939Rpm: 900, j1939Faults: 0 }, 0);
    expect(await faults()).toEqual([]);
    await send({ j1939Rpm: 900, j1939Faults: coolantHot, j1939Lamps: 2 }, 1);
    await send({ j1939Rpm: 900, j1939Faults: [coolantHot, waterInFuel], j1939Lamps: 6 }, 2);
    await send({ j1939Rpm: 900 }, 3); // a report without the fault list changes nothing
    expect((await faults()).map((f) => [f.spn, f.fmi, f.clearedAt])).toEqual([
      [110, 0, null],
      [97, 15, null],
    ]);
    const events = await faultEvents();
    expect(events.map((e) => e.detail)).toEqual([
      "Engine coolant temperature: above normal (most severe) · SPN 110 FMI 0. Lamps on: red stop lamp.",
      "Water in fuel: above normal (least severe) · SPN 97 FMI 15. Lamps on: red stop lamp, amber warning lamp.",
    ]);
    await send({ j1939Rpm: 900, j1939Faults: waterInFuel }, 10);
    const [coolant, water] = await faults();
    expect(coolant).toMatchObject({ clearedAt: at(10), lastSeenAt: at(2) });
    expect(water).toMatchObject({ clearedAt: null, lastSeenAt: at(10), firstSeenAt: at(2) });
    // The same fault coming back later is a new occurrence.
    await send({ j1939Rpm: 900, j1939Faults: [waterInFuel, coolantHot] }, 20);
    expect(await faults()).toHaveLength(3);
    expect(await faultEvents()).toHaveLength(3);
  });
});
