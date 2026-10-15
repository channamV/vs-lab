/**
 * Fills in the past week of engine history for the simulated machines (SIM00001…),
 * so the engine-hours chart has something to show. Only touches SIM* devices.
 *
 * Also adds three demo operators (PINs 1111, 2222, 3333) and a check-in with the pre-start
 * checklist at the start of each working day.
 *
 *   npm run demo:seed                  # 3 machines
 *   npm run demo:seed -- --devices 5
 *
 * Works against whichever database the platform uses (DATABASE_URL, or the embedded one).
 */
import { parseArgs } from "node:util";
import { and, eq, inArray, lt } from "drizzle-orm";
import { createDb, defaultDbOptions, migrateDb } from "../src/lib/db";
import { checkins, devices, engineSessions, operators, type ChecklistAnswer } from "../src/lib/db/schema";
import { CHECKLIST } from "../src/lib/checklist";
import { hashPin } from "../src/lib/operators";
import { appTimeZone, startOfLocalDay } from "../src/lib/telemetry/engine";

const { values: args } = parseArgs({ options: { devices: { type: "string", default: "3" } } });
const count = Math.max(1, Number(args.devices));

const HOUR = 3_600_000;
const rand = (min: number, max: number) => min + Math.random() * (max - min);

async function main() {
  const opts = defaultDbOptions();
  const db = createDb(opts);
  await migrateDb(db, "url" in opts);

  const now = Date.now();
  const tz = appTimeZone();
  const todayStart = startOfLocalDay(now, tz);

  // Demo operators: reuse them if they already exist (same PIN).
  const demoOperators = [];
  for (const [name, pin] of [["Demo · Jane Smith", "1111"], ["Demo · Raj Patel", "2222"], ["Demo · Luc Tremblay", "3333"]]) {
    await db.insert(operators).values({ name, pinHash: hashPin(pin) }).onConflictDoNothing();
    const [op] = await db.select().from(operators).where(eq(operators.pinHash, hashPin(pin)));
    demoOperators.push(op);
  }
  const demoIds = demoOperators.map((o) => o.id);

  for (let n = 1; n <= count; n++) {
    const id = `SIM${String(n).padStart(5, "0")}`;
    await db.insert(devices).values({ id }).onConflictDoNothing();
    // Replace earlier demo history (before today) so re-running doesn't double up.
    await db.delete(engineSessions).where(and(eq(engineSessions.deviceId, id), lt(engineSessions.startedAt, new Date(todayStart))));
    await db
      .delete(checkins)
      .where(and(eq(checkins.deviceId, id), inArray(checkins.operatorId, demoIds), lt(checkins.startedAt, new Date(todayStart))));
    const checkinRows = [];

    const rows = [];
    for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
      const dayStart = startOfLocalDay(now, tz, daysAgo);
      const weekday = new Date(dayStart + 12 * HOUR).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
      if (weekday === "Sun" || (weekday === "Sat" && Math.random() < 0.6)) continue;

      // A working day: several engine-on stretches between ~7 am and ~4 pm, with idle gaps.
      let t = dayStart + rand(6.75, 8) * HOUR;
      const endOfDay = dayStart + rand(15, 17) * HOUR;

      // The operator checks in a few minutes before the first start; now and then an item fails.
      const answers: ChecklistAnswer[] = CHECKLIST.map((item) => ({ ...item, ok: Math.random() > 0.03 }));
      checkinRows.push({
        deviceId: id,
        operatorId: demoOperators[(n - 1 + daysAgo) % demoOperators.length].id,
        startedAt: new Date(t - rand(3, 12) * 60_000),
        endedAt: new Date(endOfDay + rand(2, 10) * 60_000),
        endReason: "checkout",
        authorized: true,
        checklistOk: answers.every((a) => a.ok),
        answers,
      });
      while (t < endOfDay) {
        const len = rand(0.4, 2.2) * HOUR * (0.6 + 0.2 * (n % 3));
        const end = Math.min(t + len, endOfDay);
        rows.push({ deviceId: id, startedAt: new Date(t), endedAt: new Date(end), lastSeenAt: new Date(end), source: "voltage" });
        t = end + rand(0.15, 1) * HOUR;
      }
    }
    if (rows.length) await db.insert(engineSessions).values(rows);
    if (checkinRows.length) await db.insert(checkins).values(checkinRows);
    console.log(`${id}: ${rows.length} engine sessions and ${checkinRows.length} check-ins over the past week`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
