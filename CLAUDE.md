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

## Organizations, sign-in and access rules

- **Machines vs devices** (Craig's decision, 2026-10-17; `docs/machines-and-devices.md`). A `machine` is the
  customer's equipment and owns all data (telemetry/events carry `machine_id`; engine sessions, check-ins,
  alerts, approvals, PIN failures are per machine). A `device` is hardware that supplies data while paired
  (`device_assignments`, one open pairing per device and per machine). Ingest resolves the pairing;
  unpaired devices store telemetry only. `devices.organization_id` = whose stock (null = Veristart's).
  Only platform admins pair/unpair/move stock (`src/lib/machines.ts`, tested). Machines get a random `code`
  for the QR URL; migrated machines kept the old device ID as code.
- **Multi-tenant.** Every customer is an `organization`. Machines, operators, check-ins, alerts and users
  belong to one. Every page read in `src/lib/data.ts` and every admin
  action filters by the signed-in user's `organizationId`; per-machine reads go through `requireMachine()`.
  Never query tenant data without that filter. Logic modules take `organizationId` as a parameter.
- **Sign-in** is an emailed one-time link (`src/lib/auth.ts`, tested): only token hashes are stored; the
  link opens `/login/verify`, where a button (POST) signs in, because email scanners pre-open links.
  Sessions are DB rows; the cookie holds a random token. Roles: owner / manager / viewer.
  Platform admins = `PLATFORM_ADMIN_EMAILS` (env); they can switch the organization they view.
  `ADMIN_PASSWORD` is a transition fallback that signs in as the first platform admin; remove it later.
- `src/proxy.ts` only checks a session cookie is present; `src/lib/session.ts` validates it against the
  database. Every admin server action must call `requireAuth("manager" | "owner")` (or
  `requirePlatformAdmin()`) itself: server actions can be posted to any route, including public ones.
- Unauthenticated: `/hub/api/*` (devices), `/login*`, and `/checkin/<machine code>` (operator QR check-in,
  `src/app/checkin/`). The check-in page reads only through `src/lib/checkin-page.ts` (machine name, unit # +
  current operator); its actions accept just a machine code, PIN and checklist answers. PINs are unique per
  organization; the machine identifies the organization.
- Admin pages live in `src/app/(admin)/` (with the nav bar); check-in pages have their own layout.

## Commands (run from `platform/`)

```
npm run dev          # migrate DB + start at http://localhost:3000
npm run simulate     # fake devices sending real Telelogger-format data (engines cycle on/off)
npm run demo:seed    # demo machines paired with the SIM* devices + a week of engine/check-in history
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
- Organizations, users: `src/lib/organizations.ts`. Machines, pairing, device stock: `src/lib/machines.ts` (both tested).
- Operators, approvals, check-in/out, PIN rate limit and phone-location check: `src/lib/operators.ts`
  (takes the db, tested; thresholds in `CHECKIN_RULES`). Flag wording: `src/lib/checkin-flags.ts`.
  The pre-start checklist questions: `src/lib/checklist.ts`.
- Check-ins follow the engine (Craig's rule, 2026-10-17): start within 5 min → the check-in is linked to that
  engine session (`checkins.engine_session_id`); engine stops (after a break allowance by check-in
  `method`: web 30 min, ble 0, `CHECKIN_RULES.breakMinutes`) or no start → automatic check-out, recorded at
  the engine-stop time. A restart within the allowance re-links to the new session. Operators never have to check out. `syncCheckins()` saves this on each device report and before check-in/out;
  pages apply the same rules on read (`automaticEnd`, `isCheckinCurrent`) so they're right between reports.
- Alerts: rules in `src/lib/alerts.ts` (takes the db, tested; `ALERT_RULES`), email via Resend's HTTP API in
  `src/lib/notify.ts` (recipients: the organization's owners + managers, plus `ALERT_EMAIL_TO`). Rules run in `after()` (`src/lib/alert-jobs.ts`) from the device routes and the
  check-in action, so they never delay or break a device's HTTP 200. Dedupe is by unique index
  (one per engine session / per check-in).
- Forms using `useActionState`: React clears fields after every submit, so on an error return the
  submitted values and re-key the form (see `CheckinForms.tsx`, `OperatorForms.tsx`).
- Engine on/off detection and engine-hours maths live in `src/lib/telemetry/engine.ts` (pure functions, tested).
  Ingest keeps `engine_sessions` up to date: at most one open session per device.
- Schema changes: edit `schema.ts`, run `db:generate`, commit the generated SQL. Never edit applied migrations.
- Add a test for every parser/ingest change (`*.test.ts`, Vitest, in-memory PGlite).
- Product language: tiers are "GPS & Telematics", "Safety & Access Monitoring",
  "Safety & Access Control" (`gps` / `monitor` / `control`). Control (starter relay) is out of scope for now.
