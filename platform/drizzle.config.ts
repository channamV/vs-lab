import { defineConfig } from "drizzle-kit";

// Used only to generate SQL migration files from src/lib/db/schema.ts:
//   npm run db:generate
// Migrations are applied by scripts/migrate.ts (npm run db:migrate).
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
});
