/**
 * Fills in the past week of engine history for the simulated machines (SIM00001…),
 * so the engine-hours chart has something to show. Only touches SIM* devices.
 *
 *   npm run demo:seed                  # 3 machines
 *   npm run demo:seed -- --devices 5
 *
 * Works against whichever database the platform uses (DATABASE_URL, or the embedded one).
 */
import { parseArgs } from "node:util";
import { and, eq, lt } from "drizzle-orm";
import { createDb, defaultDbOptions, migrateDb } from "../src/lib/db";
import { devices, engineSessions } from "../src/lib/db/schema";
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

  for (let n = 1; n <= count; n++) {
    const id = `SIM${String(n).padStart(5, "0")}`;
    await db.insert(devices).values({ id }).onConflictDoNothing();
    // Replace earlier demo history (before today) so re-running doesn't double up.
    await db.delete(engineSessions).where(and(eq(engineSessions.deviceId, id), lt(engineSessions.startedAt, new Date(todayStart))));

    const rows = [];
    for (let daysAgo = 6; daysAgo >= 1; daysAgo--) {
      const dayStart = startOfLocalDay(now, tz, daysAgo);
      const weekday = new Date(dayStart + 12 * HOUR).toLocaleDateString("en-US", { timeZone: tz, weekday: "short" });
      if (weekday === "Sun" || (weekday === "Sat" && Math.random() < 0.6)) continue;

      // A working day: several engine-on stretches between ~7 am and ~4 pm, with idle gaps.
      let t = dayStart + rand(6.75, 8) * HOUR;
      const endOfDay = dayStart + rand(15, 17) * HOUR;
      while (t < endOfDay) {
        const len = rand(0.4, 2.2) * HOUR * (0.6 + 0.2 * (n % 3));
        const end = Math.min(t + len, endOfDay);
        rows.push({ deviceId: id, startedAt: new Date(t), endedAt: new Date(end), lastSeenAt: new Date(end), source: "voltage" });
        t = end + rand(0.15, 1) * HOUR;
      }
    }
    if (rows.length) await db.insert(engineSessions).values(rows);
    console.log(`${id}: ${rows.length} engine sessions over the past week`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
