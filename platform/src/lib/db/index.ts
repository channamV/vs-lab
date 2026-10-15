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

/**
 * Connection string from the environment. Vercel's Neon integration sets DATABASE_URL;
 * POSTGRES_URL is accepted too in case the integration was set up with that name.
 */
export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

export function defaultDbOptions() {
  const url = databaseUrl();
  if (url) return { url };
  // On Vercel the file system is read-only and wiped between requests, so the embedded
  // database can't work there. Fail the build with a clear message instead.
  if (process.env.VERCEL) {
    throw new Error(
      "No database connection: DATABASE_URL is not set for this Vercel deployment. " +
        "In Vercel → this project → Storage, connect the Neon database to this project " +
        "(tick Production and Preview), then redeploy.",
    );
  }
  return { dataDir: path.join(process.cwd(), ".data", "pglite") };
}

// Reuse one connection per server process (also survives dev hot reloads).
const globalForDb = globalThis as unknown as { vsLabDb?: Db };

export function getDb(): Db {
  globalForDb.vsLabDb ??= createDb(defaultDbOptions());
  return globalForDb.vsLabDb;
}

export { schema };
