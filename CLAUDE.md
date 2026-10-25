# VS Lab

A personal lab for equipment visibility, safety and access monitoring — modelled on the Veristart
product tiers, built independently of Veristart's production stack. Owner: Craig (non-engineer,
Windows PC). Explain changes in plain language and keep the docs in `docs/` current. Craig is a CEO with
an accounting background, not a software engineer: keep what he has to read or do short and simple (outcome
first, then any steps for him); technical detail goes in the docs, e.g. `docs/hardware-bringup.md`.

## Layout

| Path | What |
|---|---|
| `platform/` | Web app + device API. Next.js 16 (App Router, Cache Components), TypeScript, Drizzle ORM, PostgreSQL |
| `firmware/` | Our build of Freematics Telelogger (`telelogger/`, `libraries/`; upstream copy in commit 51160f1) + notes |
| `docs/` | Runbooks written for a non-engineer: setup, device, deploy, product tiers |

## Hardware

Freematics ONE+ **Model H**, SIM7670 (LTE Cat 1) modem, ESP32. SIM cards: **Soracom, plan01s** (APN `soracom.io`). Runs **our build of Freematics
Telelogger** (`firmware/telelogger`, PlatformIO envs `bench`/`vehicle`/`bench-nobt`; Bluetooth is required in deployment
(beacons + phone app authorise operators; Craig 2026-10-24), off only for early Wi-Fi bench tests, see `firmware/README.md`; settings as build flags in `platformio.ini`,
config.h untouched) posting "HTTPS POST" to our server. **The SIM7670 cannot send TLS SNI, so cellular goes through Soracom Beam
(`bench-beam*` envs); direct cellular HTTPS to Vercel fails with 421.** Current state, findings, decisions and open items for the
device: **read `docs/hardware-bringup.md` first, and update it after each device step.** Build/flash only on Craig's PC (PlatformIO's registry is blocked in cloud sessions); `docs/freematics-setup.md`. Source of truth for the
device protocol: `firmware_v5/telelogger` and `libraries/FreematicsPlus` in
github.com/stanleyhuangyc/Freematics.

## Device protocol (do not break — real devices depend on it)

- `POST /hub/api/post/<DEVID>` — body `PID:val[;val],...*CHECKSUM` (hex PIDs, PID 0 starts a sample)
- `GET  /hub/api/notify/<DEVID>?EV=&SSI=&VIN=` — connection events (1 login, 2 logout, 7 ping...)
- `GET  /hub/api/push?id=&lat=&lon=&speed=<knots>...` — "HTTPS GET" mode (GPS only)
- Our fork only: notify `FW=<version>` (→ `devices.firmware_version`), and `GET /hub/api/firmware/<release>?d=&s=` (download)
- Device only checks for HTTP 200. Parser: `platform/src/lib/freematics/protocol.ts`. Text replies go through
  `deviceReply` (`src/lib/freematics/reply.ts`): it sets Content-Length; Telelogger waits ~5 s on chunked replies.
- Device commands (`src/lib/commands.ts`, tested; `docs/device-commands.md`): replies to post/notify/push are
  `OK …` plus `CMD <id> <sig> <command>` lines (stock firmware ignores them); our fork answers at
  `GET /hub/api/ack/<DEVID>?id=&ok=&result=&sig=`. HMAC per-device key from `DEVICE_KEY_SECRET` (unset = unsigned).
  Queued by platform admins on `/platform/devices/<id>`; resent each minute ≤5×, expire after 24 h.
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
- **Divisions** (optional, one level; `src/lib/divisions.ts`, tested). A machine is in one division or none
  (`machines.division_id`). `user_divisions` limits a manager/viewer to some divisions; none = whole org;
  owners and platform admins are never limited. `AuthContext.divisionIds` (null = all) is the `Scope`:
  page reads filter machines with `machineScope(auth)` (check-ins/alerts via their machine); actions on a
  machine/check-in/alert call `assertMachineInScope` / `assertCheckinInScope` / `assertAlertInScope`, and
  machine create/edit calls `assertDivisionChoice`. Operators are org-wide. Notifications check `canSeeMachine`.
  Non-empty divisions can't be deleted (it would widen limited users' access).
- **Multi-tenant.** Every customer is an `organization`. Machines, operators, check-ins, alerts and users
  belong to one. Every page read in `src/lib/data.ts` and every admin
  action filters by the signed-in user's `organizationId`; per-machine reads go through `requireMachine()`.
  Never query tenant data without that filter. Logic modules take `organizationId` as a parameter.
- **Sign-in** is an emailed one-time link (`src/lib/auth.ts`, tested): only token hashes are stored; the
  link opens `/login/verify`, where a button (POST) signs in, because email scanners pre-open links.
  Sessions are DB rows; the cookie holds a random token. Roles: owner / manager / viewer.
  Platform admins = `PLATFORM_ADMIN_EMAILS` (env); they can switch the organization they view.
  `ADMIN_PASSWORD` is a transition fallback that signs in as the first platform admin. Craig wants it kept
  for now (2026-10-19): **remind him to remove it when vs-lab gets outside users.**
- `src/proxy.ts` only checks a session cookie is present; `src/lib/session.ts` validates it against the
  database. Every admin server action must call `requireAuth("manager" | "owner")` (or
  `requirePlatformAdmin()`) itself: server actions can be posted to any route, including public ones.
- Unauthenticated: `/hub/api/*` (devices), `/api/jobs/*` (Vercel Cron; each checks `Bearer CRON_SECRET` via `src/lib/cron.ts`), `/login*`, and `/checkin/<machine code>` (operator QR check-in,
  `src/app/checkin/`). The check-in page reads only through `src/lib/checkin-page.ts` (machine name, unit # +
  current operator); its actions accept just a machine code, PIN and checklist answers. PINs are unique per
  organization; the machine identifies the organization.
- Admin pages live in `src/app/(admin)/`; its layout builds the menu (groups/roles) and `src/components/AppNav.tsx` draws it
  (desktop sidebar collapsible to icons, cookie `vs-nav`; phones: top bar + slide-in menu). Add new pages there.
  Check-in pages have their own layout.

## Commands (run from `platform/`)

```
npm run dev          # migrate DB + start at http://localhost:3000
npm run simulate     # fake devices sending real Telelogger-format data (engines cycle on/off; --obd some|all|none)
npm run demo:seed    # demo machines paired with the SIM* devices + a week of engine/check-in history
npm run retention    # privacy clean-up once (Vercel runs it nightly)
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
- Once vs-lab has outside users, switch back to branches + pull requests reviewed before merging, and remind
  Craig to remove the `ADMIN_PASSWORD` fallback (Vercel setting + code in `src/lib/auth.ts`). It must go before any
  EU customer goes live (GDPR, `docs/privacy.md`).

## Privacy compliance reminder (Craig's request, 2026-10-22)

vs-lab is **not yet compliant with Veristart's own privacy policy** (2024-09-23) or ready for Canadian customers'
real data: see the "Must fix" items in `docs/privacy-canada.md` (Canadian hosting, operator/employer roles,
safety-monitoring wording, Quebec consent, breach procedure). **Remind Craig of this occasionally** (e.g. when
finishing a feature that touches personal data, or before any customer/pilot use) until the doc's status line
says it's compliant. Update that doc when items are done.

## Conventions

- Next.js 16 differs from older versions: read `platform/node_modules/next/dist/docs/` before
  using an API you're unsure of. `middleware` is now `proxy`. Request-time data must sit under
  `<Suspense>`; data functions call `connection()` (via `requireSession`).
- All DB reads for pages go through `src/lib/data.ts`. Device writes go through `src/lib/telemetry/ingest.ts`.
- Organizations, users: `src/lib/organizations.ts`. Machines, pairing, device stock: `src/lib/machines.ts` (both tested).
- Operators, approvals, check-in/out, PIN rate limit and phone-location check: `src/lib/operators.ts`
  (takes the db, tested; thresholds in `CHECKIN_RULES`). Flag wording: `src/lib/checkin-flags.ts`.
- Checklists (`src/lib/checklists.ts`, tested; Craig's design 2026-10-19, `docs/checklists.md`): per-org answer sets
  (labels free, each with a severity pass/minor/major/na) and templates (sections → questions with stable ids,
  one answer set, customizable confirmation text; one `is_default`). Machine uses `checklist_template_id` or the
  default; `ensureChecklistDefaults` creates defaults lazily. Check-ins snapshot questions/answers/confirmation.
  Defects → `checklist_issues` (one open per machine+question; repeats stack, escalation re-alerts via
  `alert_checkin_id`); minor and major both raise "Repair needed". Major + operator's choice → machine
  `locked_out_at` (no check-ins until a manager clears it) + `equipment_locked` notification.
  Question kinds also include `textOnly` (written answer, e.g. odometer; the text is the answer). Ready-made checklists
  (`src/lib/checklist-library.ts`, tested; Checklists → Ready-made → Add): NL trip inspection Schedule A (NLR 27/12).
- Checklist photos (`src/lib/photos.ts`, tested): questions have `photoRequired` / `photoOnly` (missing = false).
  The phone shrinks photos (CheckinForms.tsx) and sends them with the check-in action as `photo:<questionId>`
  files (server action body limit 4mb in next.config.ts; Vercel caps requests at 4.5 MB). `checkIn` validates
  (`PHOTO_RULES`), stores them in the private Vercel Blob store (`BLOB_READ_WRITE_TOKEN`; local `.data/photos`
  without it) and records `checkin_photos` (with an `analysis` slot for future AI). Photos are only served by
  `/photos/<id>` (session + `canSeeMachine`).
- Tamper watchdog (`src/lib/tamper.ts`, tested; `docs/tamper.md`): stock Telelogger reports every 1–5 s running,
  signs off ("logout") when parked, then checks in every 15 min. `watchdog()` (Vercel Cron every 5 min →
  `/api/jobs/watchdog` → `runWatchdog`; `npm run watchdog` locally) scores quiet paired devices with
  `scoreSilence` (pure; `TAMPER_RULES`) into `device_incidents` (concern low/medium/high + reasons). Ingest calls
  `noteContact` (ends a quiet spell; VIN change; restart without sign-off) and `checkMovement` (moved while
  quiet). `notifyIncidents` raises `tamper` / `tamper-escalated` alerts (medium+) and `equipment_offline`
  notifications. Both jobs are in `crons` in `platform/vercel.json` (the team is on Vercel Pro since 2026-10-21).
- Worksites / "geo-lock" (`src/lib/worksites.ts` + `src/lib/worksite-types.ts` (geometry, types; browser-safe), tested;
  `docs/worksites.md`; UI modelled on Veristart Insights' Worksites). Org-wide polygons (`[lat,lng][]`, unclosed),
  edited at `/worksites` by whole-org managers/owners (`canEditWorksites`). Ingest calls `updatePresence` on each fix
  (`worksite_visits`, one open per machine+site; leave needs `WORKSITE_RULES.exitBufferM` outside; <4 satellites
  ignored; overlaps allowed) and `checkDwell` (also in `runWatchdog`). Events `worksite_enter/leave/dwell` carry
  `worksite_id` + `worksite_visit_id` (unique per type+visit); rules' `worksite_ids` filter only worksite events.
  Visits are deleted with the telemetry retention.
- Reports (`src/lib/reports.ts`, tested; `docs/reports.md`; `/reports` + CSV at `/reports/export?report=`): `reportRange`
  (presets/custom, company time zone, ≤92 days), `buildReport` (engine sessions clipped per local day; idle per day
  from the best source, reported as `idleSource`: J1939 idle meter delta, else share of engine-on telemetry with RPM <
  `REPORT_RULES.idleRpm` (measured), else speed < 1 km/h (estimated, labelled so); operator hours via
  check-ins linked to sessions; compliance = days run with a check-in ÷ days run; utilization vs org
  `planned_hours_per_day` × `working_days` (Settings); worksite engine hours = sessions ∩ visits). Charts are plain
  HTML in `reports/charts.tsx` (validated blue/orange, one blue ramp; hover + sr-only tables).
- J1939 engine data (`docs/can-data.md`): our own PIDs 0x301–0x311 (0x308/0x309 idle hours/fuel) in `protocol.ts` (for the future firmware fork;
  simulator sends them). `detectEngine` prefers `j1939Rpm`. `src/lib/faults.ts` (tested) `updateEngineData` from
  ingest: `machines.engine_hour_meter`, DM1 faults (SPN×32+FMI) → `machine_faults` (one open per machine+SPN+FMI,
  cleared when absent from a fault list) + `engine_fault` event; wording in `src/lib/j1939.ts`. Reports: fuel/hours
  from meter deltas.
- Fuel theft (`src/lib/fuel.ts`, tested): `checkFuelTheft` in `afterDeviceReport` — once per engine session, after
  `FUEL_RULES.settleMinutes`, median of first readings after start vs last readings before it (J1939 `j1939FuelLevelPct`
  or `obdFuelLevelPct`); drop ≥ 5% (and ≥ 20 L with `machines.fuel_tank_litres`) → `fuel-theft` alert (any tier) →
  `possible_fuel_theft` event. `engine_sessions.fuel_start_pct/fuel_checked_at` record the check; a rise is a parked
  refuel. `checkFuelWhileRunning` (every 5 min, anchor `engine_sessions.fuel_anchor_*`, renewed hourly): rise → running
  refuel; J1939 + tank size: tank drop − meter burn ≥ 5%/20 L → `fuel-loss` alert. Refuels/thefts → `fuel_events`
  (machine page Fuel section, Reports → Fuel tab + CSV; `refuel` notification event).
- Safety (`src/lib/safety.ts`, tested; `docs/safety.md`; kinds/units in browser-safe `src/lib/safety-kinds.ts`): org limits
  `speed_limit_kph` / `idle_alert_minutes` / `fatigue_daily_hours` / `fatigue_continuous_hours` (null = off; owner Settings →
  Safety rules), `machines.speed_limit_kph` (replaces the fleet limit) and `worksites.speed_limit_kph` (a lower open-visit
  site limit wins; `speedLimitFor`). Ingest calls `checkSpeedAndIdle`
  (after the worksite check): speeding spell = `safety_events` row tracked by `machines.speeding_event_id`, notified
  (`speeding`) after `SAFETY_RULES.speedingGraceSeconds`, unnotified spikes deleted; idle (RPM only, `idleState`) via
  `machines.idle_since/idle_event_id` → `excessive_idle`; a device gap > `gapMinutes` ends both. Worksite type
  `restricted` → `checkRestrictedAreas` in `afterDeviceReport` → `restricted-area` alert (unique per `worksite_visit_id`) →
  `restricted_area` event. `checkFatigue` (in `runWatchdog`): engine time while checked in, per operator; daily and
  continuous (gaps < 15 min merged) → `operator_fatigue`, deduped by `safety_events.dedupe_key`. Reports → Safety tab + CSV.
  Safety log is in retention (check-in period), operator export and erase.
- Posted speed limits (Craig 2026-10-25; `src/lib/road-limits.ts` pure + `src/lib/posted-speed.ts`, tested;
  `docs/posted-speed-limits.md`): on-road machines only (`machines.on_road`, auto-ticked for the Pickup / on-road Dump truck
  categories), org `posted_limit_tolerance_pct` (null = off; Settings → Safety rules). Cron `/api/jobs/posted-speed` every
  5 min → `checkPostedSpeeds`: telemetry since `machines.road_checked_until` (≤6 h per run, 3 min settle), roads from
  Overpass per 0.05° square (`road_tiles`, 30-day cache, ≤3 downloads per run, only square corners sent), matching
  (25 m, heading, one-way, sticky), spells > limit×(1+tol) for ≥10 s → safety event `posted_speeding` (dedupe
  machine+start; open spells re-checked next run) + `posted_speeding` notification; `road_coverage` km known/unknown/
  off-road per org+month (Settings table, to decide on paid data such as TomTom).
- Firmware updates (`src/lib/firmware.ts`, tested; `docs/firmware-updates.md`): staff upload releases at `/platform/firmware`
  (`firmware_releases`: version unique, sha256, file in the private Blob store under `firmware/`, `.data/firmware` locally).
  `queueUpdate` adds `UPDATE=<version>\t<bytes>\t<sha256>\t<path>` commands (`device_commands.firmware_release_id`, 7-day
  expiry; skips devices on the version or waiting; a newer choice cancels the old). `authorizeDownload` = device was sent
  it + signature (`downloadSignature`). Ack ok → `afterUpdateAnswer` sets the version. Retire = no more sends/downloads.
- Operating modes (`src/lib/modes.ts` + browser-safe `src/lib/mode-types.ts`, tested; `docs/operating-modes.md`; replaced
  arm/disarm 2026-10-22): `machines.mode` access_controlled / unlocked / locked (GPS tier: no access_controlled — it
  behaves as unlocked), timed via `mode_until` + `mode_revert_to` (`currentMode` applies expiry on read;
  `applyModeTimers` in `runWatchdog`). `effectiveMode` = checklist safety lock (`locked_out_at`) else `currentMode`.
  `setMode` (managers only) records `machine_mode_changes` + `mode_changed` event and, for tier `control`, queues
  `MODE=<mode>\t<offline|keep>\t<hours>` (ack ok → `confirmMode` → `confirmed_mode`). `isArmed` = Access-Controlled.
  Locked: `checkLockedUse` in `afterDeviceReport` → `locked-use` (per engine session) / `locked-movement` (> 100 m from
  `lock_anchor_*`, once per lock) alerts → `start_while_locked` / `unauthorized_movement` events; check-ins refused
  (`machine-locked`). Offline fallback `offline_mode` (null = keep) + `offline_after_hours`, enforced by relay firmware.
- Schedules (Jira V1-267; `src/lib/schedules.ts` + browser-safe `src/lib/schedule-time.ts`, tested; `docs/schedules.md`;
  `/schedules`): `schedules` rows (action machine_mode / operator_access; recurrence once / weekly / override; wall-clock
  times in `timezone`; end_behavior revert / set_mode). `runSchedules` (Vercel Cron every minute → `/api/jobs/schedules`
  → `runScheduleJob`; also `npm run watchdog`) calls `reconcileOrganization`: per machine `resolveMachine` (overrides >
  regular; org `schedule_conflict_rule` least/most restrictive; operator access turns scheduled Locked into
  Access-Controlled; windows started before `machines.manual_mode_at` skipped) → `setMode` (source schedule,
  `machines.schedule_id`, `mode_before_schedule` for revert). Manager `setMode` sets `manual_mode_at` and releases the
  schedule. Save/edit/pause/delete reconcile at once; pause releases without reverting; delete applies end behaviour.
  Permissions = live permissions (`allowedActions`: managers+, divisions), checked on save and on every run
  (`creatorScope`). Scheduled access → `scheduledAccess` in `checkIn` authorization (approvals unchanged). Relay
  machines: MODE commands sorted unlocks first; unconfirmed after 10 min → `schedule-late` alert. Override reminders
  emailed to the creator 15 min before the end. Org `timezone` ("Company time zone", owner Settings) is used for everything shown and counted per day: pages via
  `auth.timeZone` / `companyTimeZone()` (data.ts), jobs and alert wording via `orgTimeZone` / `orgTimeZones` (`src/lib/org-time.ts`);
  `appTimeZone()` (`APP_TIMEZONE`, default Toronto) is only the fallback. Schedules can still use their own zone.
- Training (`src/lib/training.ts` + browser-safe `src/lib/training-status.ts`, tested; `docs/training.md`; `/training`,
  records on `/operators/<id>`). Per-org `machine_categories` (`machines.category_id`) and `certification_types` (covers
  `categoryIds`/`machineIds`; `autoGrant` + `required` must both be answered; validity, grace, reminder days, active;
  starters seeded inactive by `ensureTrainingDefaults`). `training_records` are added by managers (no approval), with an
  optional private certificate (`saveDocument`, served by `/training/documents/<id>`). Latest record per operator+type
  counts (`latestRecords`). `checkIn` calls `trainingAccess`: missing required → `training-required`; auto-grant →
  authorized. `sendTrainingReminders` (in `runWatchdog`) → `training_expiring/expired` events (machine-less; rules with
  machine/division filters skip them) + email to `operators.email`. Records/contacts are in export and erase.
- Scan to fill (`src/lib/scan.ts`, tested with a fake client; `docs/scan-to-fill.md`): Claude (`claude-opus-5-5`, low effort,
  Zod structured output, `fallbacks: "default"`) reads certificate / serial plate or VIN photos (`scanPlateAction` also checks the number in the same step; a decoded VIN leads, `repairVin` fixes I/O/Q and one look-alike character on scans only); needs `ANTHROPIC_API_KEY` (unset =
  no Scan buttons). Saves nothing: manager-only actions (`scanCertificateAction`, `scanPlateAction`) return fields for the
  form; `src/components/ScanButton.tsx` is reusable. A certificate photo is kept only by attaching it as the record's
  document (`organizations.retain_scan_images` default, per-scan checkbox). Plate photos aren't kept.
  VIN/PIN check (`src/lib/vin.ts`, tested): check digit + NHTSA vPIC decode for VINs, manufacturer from equipment PIN
  prefixes (`EQUIPMENT_WMI`); `lookupSerialAction` via "Check VIN / PIN"; fills empty fields only.
- History (`src/lib/history.ts` + browser-safe `src/lib/history-track.ts`, tested; `docs/location-history.md`; modelled on
  Insights): machine page Battery voltage (`voltageHistory`: per-slice min/max/avg via GROUP BY floor(epoch/slice) with the
  slice inlined, engine spans, 12/24 V; `VoltageChart.tsx`; CSV `machines/[id]/battery/export`) and `/machines/[id]/history`
  (`historyRange` presets/custom ≤31 days in `appTimeZone()`; `locationHistory` thins with DISTINCT ON above
  `HISTORY_RULES.maxTrackPoints`; `dropOutliers`, `splitSegments`, `findStops`, operators from check-ins;
  `HistoryReplay.tsx` replay with skip-parked-time timeline; CSV `history/export`). Popups are built with textContent.
- Low battery (`src/lib/battery.ts`, tested): engine-off readings below 11.9 V / 23.8 V, confirmed 3 min later →
  `machines.battery_low_at` + `low_battery` event (once per spell; clears at +0.4 V). Called from ingest.
- Privacy / GDPR (`src/lib/privacy.ts`, tested; `docs/privacy.md`): per-org `privacy_contact` and `retain_*_days`
  (limits in `src/lib/privacy-limits.ts`, edited on the owner-only `/settings` page). `applyRetention` (Vercel Cron
  daily → `/api/jobs/retention`; `npm run retention`) clears phone locations, deletes photos (files via `deletePhotos`
  first), telemetry, events, old check-ins/alerts/resolved issues/incidents/notifications, expired sessions.
  `exportOperator` (JSON at `/operators/<id>/export`) and `eraseOperator` (placeholder "Former operator #id", PIN
  unusable, approvals/locations/photos removed, name replaced in text; check-ins kept; `operators.erased_at`) are for
  whole-org managers/owners (`canManageOperatorData`). `audit_log` (shown on Settings) records staff switching into an
  org (`viewOrganization`) and exports/erasures. New personal data → add it to retention, export and erase, and to
  the check-in privacy notice. Canada/PIPEDA: `docs/privacy-canada.md`; breach register `src/lib/breaches.ts` (tested;
  staff page `/platform/breaches`; never deleted by retention).
- Check-ins follow the engine (Craig's rule, 2026-10-17): start within 5 min → the check-in is linked to that
  engine session (`checkins.engine_session_id`); engine stops (after a break allowance by check-in
  `method`: web 30 min, ble 0, `CHECKIN_RULES.breakMinutes`) or no start → automatic check-out, recorded at
  the engine-stop time. A restart within the allowance re-links to the new session. Operators never have to check out. `syncCheckins()` saves this on each device report and before check-in/out;
  pages apply the same rules on read (`automaticEnd`, `isCheckinCurrent`) so they're right between reports.
- Alerts: rules in `src/lib/alerts.ts` (takes the db, tested; `ALERT_RULES`), email via Resend's HTTP API in
  `src/lib/notify.ts`. Rules run in `after()` (`src/lib/alert-jobs.ts`) from the device routes and the
  check-in action, so they never delay or break a device's HTTP 200. Dedupe is by unique index
  (one per engine session / per check-in).
- Notifications (`src/lib/notifications.ts`, tested; UI modelled on production's notification subscriptions):
  events (`notification_events`: engine start/stop recorded in ingest, alerts via `deliverAlerts`, machine and
  approval changes via `recordEvent` + `afterEvents`) are matched against per-user `notification_rules` (event
  types, machines/divisions/operators — empty = all, weekdays + From/To in the rule's timezone, overnight wrap)
  by `processEvents` in `after()`, only for users who can see the machine. One `notification_deliveries` row
  per event/person/channel. Email goes to the sign-in address only. Alerts also go to `ALERT_EMAIL_TO`.
- Forms using `useActionState`: React clears fields after every submit, so on an error return the
  submitted values and re-key the form (see `CheckinForms.tsx`, `OperatorForms.tsx`).
- Engine on/off detection and engine-hours maths live in `src/lib/telemetry/engine.ts` (pure functions, tested).
  Ingest keeps `engine_sessions` up to date: at most one open session per device. Samples are dated `telemetry.recorded_at`
  (`sample-time.ts`, tested: GPS time `0x10` + GPS date `0x11` from our firmware, else inferred date, else uptime;
  repeats skipped: same `device_ms` within 60 s of a stored reading, `DUPLICATE_RULES`) and handled oldest first; an upload
  whose newest reading is > 2 min old is a late backlog (stored only); only readings < 2 min old set the engine state;
  sessions start at the first and end at the last running reading's `recorded_at` (not arrival).
  `endQuietEngineSessions` (device logout = asleep → at once; otherwise no running reading for `staleMinutes`, from
  notify events and `runWatchdog`) ends the session at its last reading, sets the machine's engine off, then check-outs. Tracks/history/battery chart order by `recorded_at`. Telelogger's accelerometer is
  gravity-removed (0;0;0 at rest), so vibration = `hypot(accel) >= vibrationG`. Uploads with no engine signal leave
  the state alone but set `machines.engine_unknown_since`; `engineStatus` shows "unknown" when the device is still
  reporting and that's older than `staleMinutes`.
- Schema changes: edit `schema.ts`, run `db:generate`, commit the generated SQL. Never edit applied migrations.
- Add a test for every parser/ingest change (`*.test.ts`, Vitest, in-memory PGlite).
- Product language: tiers are "GPS & Telematics", "Safety & Access Monitoring",
  "Safety & Access Control" (`gps` / `monitor` / `control`). Control (starter relay) is out of scope for now.
