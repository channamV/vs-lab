# Platform

Web app and device API. Next.js 16 · TypeScript · Drizzle ORM · PostgreSQL (or embedded PGlite) · Leaflet maps.

```
npm install
npm run dev          # http://localhost:3000 (creates/updates the database first)
npm run simulate     # fake Freematics devices — see scripts/simulate.ts for options
npm run check        # lint + typecheck + tests
```

| Path | What |
|---|---|
| `src/app/hub/api/` | Device endpoints (Freematics Telelogger protocol) |
| `src/lib/freematics/protocol.ts` | Parses/encodes the Telelogger data format |
| `src/lib/telemetry/ingest.ts` | Stores device data |
| `src/lib/data.ts` | All reads for pages (with session check) |
| `src/lib/db/schema.ts` | Database tables; migrations in `drizzle/` |
| `src/app/` | Pages: fleet (`page.tsx`), machine detail (`devices/[id]`), sign-in (`login`) |
| `scripts/` | `migrate.ts`, `simulate.ts` |

Settings: see `.env.example`.
