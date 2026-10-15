import fs from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { drizzle as drizzlePg } from "drizzle-orm/node-postgres";
import { migrate as migratePg } from "drizzle-orm/node-postgres/migrator";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import * as schema from "./schema";

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

const MIGRATIONS_FOLDER = path.join(process.cwd(), "drizzle");

/**
 * Two ways to run the database, same code either way:
 *  - DATABASE_URL set   → a real PostgreSQL server (Neon, Supabase, RDS, local Postgres).
 *  - DATABASE_URL unset → PGlite, an embedded Postgres stored in ./.data. No install needed.
 */
export function createDb(opts: { url?: string; dataDir?: string } = {}): Db {
  if (opts.url) {
    return drizzlePg(new Pool({ connectionString: opts.url }), { schema }) as unknown as Db;
  }
  // dataDir undefined → in-memory (used by tests)
  if (opts.dataDir) fs.mkdirSync(opts.dataDir, { recursive: true });
  return drizzlePglite(new PGlite(opts.dataDir), { schema }) as unknown as Db;
}

export async function migrateDb(db: Db, usingPostgres: boolean) {
  const config = { migrationsFolder: MIGRATIONS_FOLDER };
  if (usingPostgres) {
    await migratePg(db as never, config);
  } else {
    await migratePglite(db as never, config);
  }
}

export function defaultDbOptions() {
  return process.env.DATABASE_URL
    ? { url: process.env.DATABASE_URL }
    : { dataDir: path.join(process.cwd(), ".data", "pglite") };
}

// Reuse one connection per server process (also survives dev hot reloads).
const globalForDb = globalThis as unknown as { vsLabDb?: Db };

export function getDb(): Db {
  globalForDb.vsLabDb ??= createDb(defaultDbOptions());
  return globalForDb.vsLabDb;
}

export { schema };
