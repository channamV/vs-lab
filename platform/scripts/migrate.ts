/**
 * Applies database migrations (creates/updates tables).
 * Safe to run repeatedly — already-applied migrations are skipped.
 *
 *   npm run db:migrate
 */
import { createDb, defaultDbOptions, migrateDb } from "../src/lib/db";

async function main() {
  const opts = defaultDbOptions();
  const usingPostgres = "url" in opts;
  console.log(`Migrating ${usingPostgres ? "PostgreSQL (DATABASE_URL)" : `embedded database at ${opts.dataDir}`}...`);
  const db = createDb(opts);
  await migrateDb(db, usingPostgres);
  console.log("Database is up to date.");
  process.exit(0);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
