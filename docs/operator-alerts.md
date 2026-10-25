# Operator alerts (beeps)

**Why** (Craig, 2026-10-25): the operator at the machine needs to know when they're operating it with nobody checked
in, or when the pre-start checklist is due. An operator who checks in with a Bluetooth beacon (planned) has no phone
screen to prompt them, so the device's buzzer is the only way to tell them. Routine beeps (e.g. "connected") mean
nothing to an operator and should go.

| Pattern | Meaning | What the operator does |
|---|---|---|
| **Two long beeps** | The engine is running and nobody is checked in | Scan the QR code and check in |
| **Three short beeps** | Someone is checked in but no checklist covers them today | Scan the QR code and complete the checklist |

- Only while the machine is **Access-Controlled** (Safety & Access Monitoring or Control tier). Unlocked: anyone may
  operate it, so no beeps. GPS & Telematics: no beeps.
- Only while the engine runs. Repeated every 30 seconds until it's resolved.
- The QR sticker (machine page → QR sticker) has an "If you hear…" legend for these machines.
- "Checklist due" can't happen with phone check-ins today (the phone always does the checklist, or relies on today's
  under the checklist's How often setting). It's there for beacon check-ins.

## How it works

VS-lab decides (`platform/src/lib/operator-alerts.ts`, tested): after each device upload and each check-in it works
out the alert and, when it changes, queues a device command (the existing signed command queue,
[device-commands.md](device-commands.md)):

- `ALERT=not_checked_in`, `ALERT=checklist_due`, or `ALERT=none`
- expires after 10 minutes if unanswered; a newer alert cancels an unanswered older one
- the last value sent is kept in `machines.operator_alert`

## Firmware (to do, desktop session)

Our fork doesn't run device commands yet. Needed:

1. **Read `CMD <id> <sig> <command>` lines** in the replies to uploads and notifications, check the signature (HMAC
   per-device key, see device-commands.md), skip IDs already run, and answer at `GET /hub/api/ack/<DEVID>?id=&ok=&result=&sig=`.
2. **`ALERT=<kind>`:** keep the kind; while the engine runs, play the pattern every 30 s:
   - `not_checked_in`: two long beeps (about 700 ms on, 300 ms off, 700 ms on);
   - `checklist_due`: three short beeps (about 150 ms on, 150 ms off, three times);
   - `none`: stop. Also stop when the device goes to sleep (a new wake starts quiet; VS-lab resends if still needed).
3. **Remove the routine beeps:** `beep(50)` when Wi-Fi connects and when cellular is "In service" (telelogger.ino).
4. `BEEP=<n>` (staff "Sound the buzzer") comes with item 1.
