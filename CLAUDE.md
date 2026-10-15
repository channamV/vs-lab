# VS Lab

A personal lab for equipment visibility, safety and access monitoring — modelled on the Veristart
product tiers, built independently of Veristart's production stack. Owner: Craig (non-engineer,
Windows PC). Explain changes in plain language and keep the docs in `docs/` current.

## Layout

| Path | What |
|---|---|
| `platform/` | Web app + device API. Next.js 16 (App Router, Cache Components), TypeScript, Drizzle ORM, PostgreSQL |
| `firmware/` | Device firmware notes and (later) our fork of Freematics Telelogger |
| `docs/` | Runbooks written for a non-engineer: setup, device, deploy, product tiers |

## Hardware

Freematics ONE+ **Model H**, SIM7670 (LTE Cat 1) modem, ESP32. Runs the stock Freematics
**Telelogger** firmware configured for "HTTPS POST" to our server. Source of truth for the
device protocol: `firmware_v5/telelogger` and `libraries/FreematicsPlus` in
github.com/stanleyhuangyc/Freematics.

## Device protocol (do not break — real devices depend on it)

- `POST /hub/api/post/<DEVID>` — body `PID:val[;val],...*CHECKSUM` (hex PIDs, PID 0 starts a sample)
- `GET  /hub/api/notify/<DEVID>?EV=&SSI=&VIN=` — connection events (1 login, 2 logout, 7 ping...)
- `GET  /hub/api/push?id=&lat=&lon=&speed=<knots>...` — "HTTPS GET" mode (GPS only)
- Device only checks for HTTP 200. Parser: `platform/src/lib/freematics/protocol.ts`.
- `/hub/api/*` is unauthenticated (devices can't log in); everything else is behind `src/proxy.ts`
  **and** a session check in `src/lib/data.ts`. Keep both.

## Public pages and access rules

- Unauthenticated: `/hub/api/*` (devices), `/login`, and `/checkin/<machine>` (operator QR check-in,
  `src/app/checkin/`). The check-in page reads only through `src/lib/checkin-page.ts` (machine name +
  current operator); its actions accept just a machine ID, PIN and checklist answers.
- Every admin server action must call `requireAdmin()` (`src/lib/admin.ts`) itself. Server actions
  can be posted to any route, including the public ones, so the proxy alone doesn't protect them.
- Admin pages live in `src/app/(admin)/` (with the nav bar); check-in pages have their own layout.

## Commands (run from `platform/`)

```
npm run dev          # migrate DB + start at http://localhost:3000
npm run simulate     # fake devices sending real Telelogger-format data (engines cycle on/off)
npm run demo:seed    # a week of engine-session history for the SIM* devices
npm run check        # lint + typecheck + tests — run before every commit
npm run build        # production build
npm run db:generate  # after editing src/lib/db/schema.ts → creates SQL in drizzle/
npm run db:migrate   # apply migrations
```

No `DATABASE_URL` → embedded PGlite in `platform/.data/`. With `DATABASE_URL` → real Postgres.

## Git workflow

- **For now, commit straight to `main` and push** (Craig's decision, 2026-10-15). There are no outside
  users yet, and every push to `main` deploys to production on Vercel, so run `npm run check` (and
  `npm run build` for config or build changes) before pushing.
- Bigger or riskier changes (schema migrations, auth, device protocol) can still go on a branch with a
  pull request if Craig asks.
- Once vs-lab has outside users, switch back to branches + pull requests reviewed before merging.

## Conventions

- Next.js 16 differs from older versions: read `platform/node_modules/next/dist/docs/` before
  using an API you're unsure of. `middleware` is now `proxy`. Request-time data must sit under
  `<Suspense>`; data functions call `connection()` (via `requireSession`).
- All DB reads for pages go through `src/lib/data.ts`. Device writes go through `src/lib/telemetry/ingest.ts`.
- Operators, approvals, check-in/out, PIN rate limit: `src/lib/operators.ts` (takes the db, tested).
  The pre-start checklist questions: `src/lib/checklist.ts`.
- Forms using `useActionState`: React clears fields after every submit, so on an error return the
  submitted values and re-key the form (see `CheckinForms.tsx`, `OperatorForms.tsx`).
- Engine on/off detection and engine-hours maths live in `src/lib/telemetry/engine.ts` (pure functions, tested).
  Ingest keeps `engine_sessions` up to date: at most one open session per device.
- Schema changes: edit `schema.ts`, run `db:generate`, commit the generated SQL. Never edit applied migrations.
- Add a test for every parser/ingest change (`*.test.ts`, Vitest, in-memory PGlite).
- Product language: tiers are "GPS & Telematics", "Safety & Access Monitoring",
  "Safety & Access Control" (`gps` / `monitor` / `control`). Control (starter relay) is out of scope for now.
