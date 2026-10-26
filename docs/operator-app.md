# Operator app (Android and iPhone)

An app for operators that replaces the production Veristart app's flow with vs-lab's check-ins and checklists
(Craig, 2026-10-26). **Status:** the platform side (sign-in and the app's API) is built and tested; the app itself
is next (`vs-lab/mobile`, Expo / React Native, one code base for Android and iPhone); the device side is part of
firmware to-do 9 ([hardware-bringup.md](hardware-bringup.md)).

## What it does

- **Sign in with an emailed code**: the operator enters the email on their operator page, gets a 6-digit code (valid
  10 minutes, 5 tries, at most 5 codes an hour) and stays signed in on that phone for 90 days of use. No passwords.
  An address used by an operator in two companies signs in to both. Deactivating or erasing an operator signs them out.
  (Operators need an email on their operator page for this. Text messages can be added later.)
- **My machines**: the machines they're approved for (or that accept anyone), with Locked / locked out for repair,
  training they're missing, whether today's checklist is done, who's on it, open defects.
- **Checklist and check-in**: the same checklists as the QR page (how-often rules, photos, hour meter / odometer,
  town filled in from the phone). Defects become maintenance items. A check-in from the app works like one from the
  QR page (method "app", 30-minute break allowance) but needs no PIN.
- **Starting a Safety & Access Control machine** ([starter-relay.md](starter-relay.md)): after the check-in, the app
  writes a signed pass to the machine's device over Bluetooth (the device advertises as `VS-<device ID>`); the device
  checks it with its own key and lets them start. The cloud also sends the device an ALLOW, whichever arrives first.
- **Without signal at the machine**: while the phone has signal, the app keeps a pass (12 hours) for each relay
  machine the operator may start. At the machine it does the checklist in the app, uses the pass, and uploads the
  check-in (dated when it was done) once there's signal. The device reports the start too; the uploaded check-in
  replaces that report.
- **Report a problem**: title, description, photos → a maintenance item ("Reported by an operator").
- **No Stop button and no Bluetooth reconnecting**: the check-in ends when the engine stops (after the break
  allowance), and the device holds the start window and break time itself.

## Compared with the production app

Kept: sign-in, my equipment, checklist before start, start over Bluetooth, report an issue, profile. Changed:
checklists are vs-lab's (no "skip", the how-often rules decide), unlock passes are signed and expire (production
writes the operator's ID in plain text, which anyone with a Bluetooth app could copy), passwords replaced by email
codes. Dropped: Stop, the ~8,000 lines of background reconnect logic, two-factor setup (the email code is the second factor).

## For the app and firmware (technical)

API (`platform/src/app/api/app/`, JSON; every route but sign-in needs `Authorization: Bearer <token>`):

| Route | |
|---|---|
| `POST /api/app/login {email}` | Emails a code (same answer whether or not the address is known) |
| `POST /api/app/verify {email, code, deviceName}` | `{accounts: [{token, operatorId, operatorName, organizationName}]}` |
| `POST /api/app/logout` | Ends this phone's sign-in |
| `GET /api/app/me` | Operator, company, machines (mode, lockout, training missing, checklist done today, relay `bluetoothName`) |
| `GET /api/app/machines/<code>/checklist` | Questions, answers, confirmation, meter (filled from the engine computer when known), town |
| `POST /api/app/machines/<code>/checkin` | Multipart, same fields as the QR page + `completedAt` (offline); answer includes `unlock: {bluetoothName, pass}` |
| `GET /api/app/passes` | Offline passes for relay machines |
| `POST /api/app/place {lat, lng}` | "Town, PROV" for the phone's position |
| `POST /api/app/machines/<code>/problem` | Multipart `title`, `description`, `photo` files |

Unlock pass: `U1|<operator>|<check-in or 0>|<from>|<until>|<sig>` (unix seconds), sig = first 16 hex of
HMAC-SHA256(device key, `unlock\n<device>\n<operator>\n<check-in>\n<from>\n<until>`) (`-` when signing is off).
The device accepts it when the signature matches and its GPS time is inside the window, then acts as for
`ALLOW=<check-in>` (start window 5 min, break 30 min); for check-in 0 (offline pass) it reports the start at
`/hub/api/access/<device>?op=<operator>&b=APP&t=<unix time>&sig=` like a beacon start.

Code: `platform/src/lib/operator-app.ts` (tested), `src/lib/app-api.ts`. Tables `operator_login_codes`,
`operator_app_sessions` (expired ones removed by the nightly clean-up).
