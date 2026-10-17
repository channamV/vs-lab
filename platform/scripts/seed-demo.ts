/**
 * Fills in the past week of engine history for the machines the simulated devices (SIM00001…) are on,
 * so the engine-hours chart has something to show. Only touches SIM* devices and their machines.
 *
 * Each SIM device that isn't on a machine yet gets a demo machine in the first organization
 * ("Veristart Lab") and is paired with it. Also adds three demo operators (PINs 1111, 2222, 3333)
 * and a check-in with the pre-start checklist before each engine start.
 *
 *   npm run demo:seed                  # 3 machines
 *   npm run demo:seed -- --devices 5
 *
 * Works against whichever database the platform uses (DATABASE_URL, or the embedded one).
 */
import { parseArgs } from "node:util";
import { and, asc, eq, inArray, lt } from "drizzle-orm";
import { createDb, defaultDbOptions, migrateDb } from "../src/lib/db";
import { checkins, devices, engineSessions, operators, organizations, type ChecklistAnswer } from "../src/lib/db/schema";
import { createMachine, pairDevice } from "../src/lib/machines";
import { pairedMachineId } from "../src/lib/telemetry/ingest";
import { CHECKLIST } from "../src/lib/checklist";
import { hashPin } from "../src/lib/operators";
import { appTimeZone, startOfLocalDay } from "../src/lib/telemetry/engine";

const { values: args } = parseArgs({ options: { devices: { type: "string", default: "3" } } });
const count = Math.max(1, Number(args.devices));

const HOUR = 3_600_000;
const DEMO_MACHINES = [
  ["Excavator", "Caterpillar", "320"],
  ["Wheel Loader", "John Deere", "644K"],
  ["Skid Steer", "Bobcat", "S770"],
  ["Backhoe", "Case", "580N"],
  ["Dozer", "Komatsu", "D61"],
];
const rand = (min: number, max: number) => min + Math.random() * (max - min);

async function main() {
  const opts = defaultDbOptions();
  const db = createDb(opts);
  await migrateDb(db, "url" in opts);

  const now = Date.now();
  const tz = appTimeZone();
  const todayStart = startOfLocalDay(now, tz);

  // Simulated machines belong to the first organization (created if needed).
  let [org] = await db.select().from(organizations).orderBy(asc(organizations.id)).limit(1);
  if (!org) [org] = await db.insert(organizations).values({ name: "Veristart Lab" }).returning();
  const organizationId = org.id;

  // Demo operators: reuse them if they already exist (same PIN in this organization).
  const demoOperators = [];
  for (const [name, pin] of [["Demo · Jane Smith", "1111"], ["Demo · Raj Patel", "2222"], ["Demo · Luc Tremblay", "3333"]]) {
    await db.insert(operators).values({ organizationId, name, pinHash: hashPin(pin) }).onConflictDoNothing();
    const [op] = await db
      .select()
      .from(operators)
      .where(and(eq(operators.organizationId, organizationId), eq(operators.pinHash, hashPin(pin))));
    demoOperators.push(op);
  }
  const demoIds = demoOperators.map((o) => o.id);

  for (let n = 1; n <= count; n++) {
    const id = `SIM${String(n).padStart(5, "0")}`;
    await db.insert(devices).values({ id }).onConflictDoNothing();
    let machineId = await pairedMachineId(db, id);
    if (!machineId) {
      const [type, make, model] = DEMO_MACHINES[(n - 1) % DEMO_MACHINES.length];
      try {
        ({ id: machineId } = await createMachine(db, organizationId, {
          name: `${make} ${model} ${type}`,
          unitNumber: String(100 + n),
          machineType: type,
          make,
          model,
          year: 2016 + (n % 8),
        }));
      } catch {
        // Unit number taken by an earlier run whose device was unpaired: number it after the others.
        ({ id: machineId } = await createMachine(db, organizationId, { name: `${make} ${model} ${type}`, machineType: type, make, model }));
      }
      await pairDevice(db, id, machineId, new Date(startOfLocalDay(now, tz, 7)));
    }
    // Replace earlier demo history (before today) so re-running doesn't double up.
    await db.delete(engineSessions).where(and(eq(engineSessions.machineId, machineId), lt(engineSessions.startedAt, new Date(todayStart))));
    await db
      .delete(checkins)
      .where(and(eq(checkins.machineId, machineId), inArray(checkins.operatorId, demoIds), lt(checkins.startedAt, new Date(todayStart))));
    const checkinRows = [];

    let sessionCount = 0;
    for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
      const dayStart = startOfLocalDay(now, tz, daysAgo);
      const weekday = new Date(dayStart + 12 * HOUR).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
      if (weekday === "Sun" || (weekday === "Sat" && Math.random() < 0.6)) continue;

      // A working day: several engine-on stretches between ~7 am and ~4 pm, with idle gaps.
      let t = dayStart + rand(6.75, 8) * HOUR;
      const endOfDay = dayStart + rand(15, 17) * HOUR;

      const operatorId = demoOperators[(n - 1 + daysAgo) % demoOperators.length].id;
      while (t < endOfDay) {
        const len = rand(0.4, 2.2) * HOUR * (0.6 + 0.2 * (n % 3));
        const end = Math.min(t + len, endOfDay);
        const [session] = await db
          .insert(engineSessions)
          .values({ machineId, startedAt: new Date(t), endedAt: new Date(end), lastSeenAt: new Date(end), source: "voltage" })
          .returning();
        sessionCount++;

        // The operator checks in 1–4 minutes before each start and is checked out when the engine stops.
        // Now and then a checklist item fails, or the phone wasn't at the machine.
        const answers: ChecklistAnswer[] = CHECKLIST.map((item) => ({ ...item, ok: Math.random() > 0.02 }));
        checkinRows.push({
          organizationId,
          machineId,
          operatorId,
          startedAt: new Date(t - rand(1, 4) * 60_000),
          endedAt: new Date(end),
          endReason: "engine stopped",
          engineSessionId: session.id,
          engineLink: "started",
          authorized: true,
          checklistOk: answers.every((a) => a.ok),
          answers,
          ...(Math.random() < 0.05
            ? { locationCheck: "far", distanceM: rand(800, 6000) }
            : { locationCheck: "near", distanceM: rand(4, 45) }),
        });
        t = end + rand(0.15, 1) * HOUR;
      }
    }
    if (checkinRows.length) await db.insert(checkins).values(checkinRows);
    console.log(`${id}: ${sessionCount} engine sessions and ${checkinRows.length} check-ins over the past week`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
