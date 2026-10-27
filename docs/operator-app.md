# Operator app (Android and iPhone)

An app for operators that replaces the production Veristart app's flow with vs-lab's check-ins and checklists
(Craig, 2026-10-26). **Status:** the platform side (sign-in and the app's API) is built and tested; the app is
in `vs-lab/mobile` (Expo / React Native, one code base for Android and iPhone; first version 2026-10-27, Android test
builds through EAS, see [../mobile/README.md](../mobile/README.md)); the device side is part of firmware to-do 9
([hardware-bringup.md](hardware-bringup.md)). Kept out of Veristart's Apple account for now (Craig, 2026-10-26).

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
- **Lunch breaks: the phone acts as the operator's key** (session hold, Craig 2026-10-27; see below). On a Safety &
  Access Control machine, after an app check-in, the machine holds the check-in for the company's break hold (default
  90 minutes, Settings → Safety rules) after the engine stops. Only that operator's phone can restart it in that time,
  on the same check-in; anyone else has to check in. Not back in time → the check-in ended when the engine stopped.
- **No Stop button**: the check-in ends when the engine stops (after the break allowance or hold).

## Session hold: how a lunch break works

Example: Jane checks in with the app at 9:00 and starts the loader, switches off at 12:00 for lunch and gets back in at
12:50.

1. At check-in VS-lab gives her phone a **session key** for that check-in (only her phone and the machine's device can
   work it out; the device needs no signal for it). The machine's device is told the check-in has a 90-minute hold.
2. At 12:00 the engine stops: the starter is blocked straight away (no free break for anyone), and the device keeps
   Jane's check-in on hold until 13:30.
3. At 12:50 Jane walks back with her phone. The phone has kept a Bluetooth connection request open for the machine,
   so it connects by itself when she's in range; the device sends a random challenge, the phone answers with a proof
   made from the session key, and once the phone is close (in the cab) the device lets her start. If the phone didn't
   do it by itself, she taps **"I'm back: restart after my break"** on the machine in the app.
4. The device reports the resume; VS-lab keeps it as the same check-in and notes "Resumed after a break (phone)" on
   the machine page. A manager sees "on a break … held for their phone until 13:30" meanwhile.

If Jane doesn't come back by 13:30, her check-in ended at 12:00 (when the engine stopped). If Bob checks in at 12:30,
Jane's check-in ends at 12:00 and Bob's starts. The phone forgets the session when the device or VS-lab says it's over.

**Phones:** iPhone keeps the connection request open even with the app in the background or closed by the system
(Bluetooth background mode + state restoration; not after the operator swipes the app away). Android does it while the
app is still running; for the app to be woken reliably after Android closes it, the next step is a small Android module
using the system's "companion device" presence (Android 12+, one-time "allow VS Lab to connect to VS-…" prompt per
machine). The button always works as a fallback.

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
| `POST /api/app/machines/<code>/checkin` | Multipart, same fields as the QR page + `completedAt` (offline); answer includes `unlock: {bluetoothName, pass, session}` |
| `GET /api/app/passes` | Offline passes for relay machines, and `sessions`: the operator's held check-ins `{machineCode, deviceId, bluetoothName, session}` |
| `POST /api/app/place {lat, lng}` | "Town, PROV" for the phone's position |
| `POST /api/app/machines/<code>/problem` | Multipart `title`, `description`, `photo` files |

Unlock pass: `U1|<operator>|<check-in or 0>|<from>|<until>|<sig>` (unix seconds), sig = first 16 hex of
HMAC-SHA256(device key, `unlock\n<device>\n<operator>\n<check-in>\n<from>\n<until>`) (`-` when signing is off).
Bluetooth (the app, `mobile/src/lib/ble.ts`): service `7f3c0001-6a2b-4b4e-9b1e-56a5c0de0001`, unlock characteristic
`7f3c0002-6a2b-4b4e-9b1e-56a5c0de0001` (write with response, then read). The app writes the pass as ASCII; the device
answers by setting the characteristic to `OK`, `EXPIRED`, `BAD_SIG`, `LOCKED` or `NOT_YOURS`.
The device accepts it when the signature matches and its GPS time is inside the window, then acts as for
`ALLOW=<check-in>` (start window 5 min, break 30 min); for check-in 0 (offline pass) it reports the start at
`/hub/api/access/<device>?op=<operator>&b=APP&t=<unix time>&sig=` like a beacon start.

Session hold (`appSession` in operator-app.ts, `resumeCheckIn` in relay.ts, both tested; app `mobile/src/lib/ble.ts`,
`hold-rules.ts`, `hmac.ts`): session = `{checkinId, operatorId, until, holdMinutes, key}`, until = check-in + 16 h,
key = HMAC-SHA256(device key, `session\n<device>\n<operator>\n<check-in>\n<until>\n<hold>`) as 64 hex (the app keeps
it in secure storage). Bluetooth: nonce characteristic `7f3c0003-6a2b-4b4e-9b1e-56a5c0de0001` (read: a fresh random
16-hex challenge per read); the app writes `R1|<operator>|<check-in>|<until>|<hold>|<proof>` to the unlock
characteristic, proof = first 16 hex of HMAC-SHA256(session key as text, `resume\n<nonce>`); the device answers `OK`,
`NOT_HELD`, `EXPIRED`, `BAD_SIG`, `LOCKED` or `TOO_FAR`. The app keeps the connection open after `OK` and asks again
when it drops. Check-ins carry `hold_minutes` (company setting at check-in; null = normal break), `resume_count`,
`last_resumed_at`; with a hold the break allowance is the hold.

Code: `platform/src/lib/operator-app.ts` (tested), `src/lib/app-api.ts`. Tables `operator_login_codes`,
`operator_app_sessions` (expired ones removed by the nightly clean-up).
