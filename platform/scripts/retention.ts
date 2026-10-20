/**
 * Runs the privacy clean-up once (on Vercel it runs every night by itself, via Vercel Cron):
 * removes data older than each organization's retention settings (Settings page).
 *
 *   npm run retention
 */
import { createDb, defaultDbOptions } from "../src/lib/db";
import { applyRetention } from "../src/lib/privacy";

async function main() {
  const result = await applyRetention(createDb(defaultDbOptions()));
  console.log(result);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
