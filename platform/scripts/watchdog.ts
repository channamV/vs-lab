/**
 * Runs the tamper watchdog once (on Vercel it runs every 5 minutes by itself, via Vercel Cron).
 * Alerts it raises are listed on the Alerts page; emails go out if email is set up.
 *
 *   npm run watchdog
 */
import { createDb, defaultDbOptions } from "../src/lib/db";
import { deliverAlerts, processEvents } from "../src/lib/notifications";
import { notifyIncidents, watchdog } from "../src/lib/tamper";
import { checkDwell } from "../src/lib/worksites";
import { checkFatigue } from "../src/lib/safety";
import { applyModeTimers } from "../src/lib/modes";

async function main() {
  const db = createDb(defaultDbOptions());
  const result = await watchdog(db);
  const raised = await notifyIncidents(db);
  await deliverAlerts(db, raised);
  const dwell = await checkDwell(db);
  const fatigue = await checkFatigue(db);
  const modeChanges = (await applyModeTimers(db)).length;
  await processEvents(db, {});
  console.log(`Checked ${result.checked} paired devices; ${result.changed} incidents opened or escalated; ${raised.length} alerts; ${dwell} stayed-too-long; ${fatigue} operator fatigue; ${modeChanges} timed mode changes ended.`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
