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
- Every QR sticker (machine page → QR sticker) has an "If you hear…" legend, whatever the machine's tier or mode:
  a sticker lasts for years, while the tier or mode can change any day (Craig, 2026-10-25).
- "Checklist due" can't happen with phone check-ins today (the phone always does the checklist, or relies on today's
  under the checklist's How often setting). It's there for beacon check-ins.

## How it works

VS-lab decides (`platform/src/lib/operator-alerts.ts`, tested): after each device upload and each check-in it works
out the alert and, when it changes, queues a device command (the existing signed command queue,
[device-commands.md](device-commands.md)):

- `ALERT=not_checked_in`, `ALERT=checklist_due`, or `ALERT=none`
- expires after 10 minutes if unanswered; a newer alert cancels an unanswered older one
- the last value sent is kept in `machines.operator_alert`

## Firmware (done 2026-10-25, `feat/cell-beam` `a4648c2`)

- Reads `CMD <id> <sig> <command>` lines in replies to uploads and sign-ins, runs each once (the last ID is kept
  across restarts; a resent ID gets its answer again) and answers at `/hub/api/ack`.
- Signatures are checked when the device has a key (`VSLAB_DEVICE_KEY` at build time). Without one it accepts
  unsigned commands, which is what VS-lab sends until `DEVICE_KEY_SECRET` is set ([device-commands.md](device-commands.md)).
- `ALERT=not_checked_in`: two long beeps (700 ms, 300 ms gap, 700 ms); `ALERT=checklist_due`: three short (150 ms
  each, 150 ms gaps). A new alert sounds at once, then every 30 s while the engine runs (RPM if the build reads it,
  else supply voltage, else it trusts VS-lab). `ALERT=none` or the device going to sleep stops it.
- Also `BEEP=<n>` (Sound the buzzer), `REPORT` (send now) and `RESET`. Other commands answer "not supported yet".
- The routine "connected" beeps are gone.
- Tested on Y5725A32 with real commands from VS-lab: Sound the buzzer ×3, Report now, Sound the buzzer ×2, all run and
  answered. The alerts themselves (VS-lab sending `ALERT=…` while the engine runs) still need a car test.
