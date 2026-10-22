# Firmware updates (over the air)

The platform side is built: staff can upload firmware builds and send them to devices in stages. The device side
(download, check, install, roll back) will be part of our own firmware. Until a device runs it, updates do
nothing. The stock Telelogger ignores the command, so sending one is harmless.

## Uploading a release (Veristart staff)

**Platform → Firmware releases and updates** (or `/platform/firmware`).

1. **Version:** exactly what the firmware reports when it signs in, e.g. `vs-1.0.3`. This is how the platform
   knows which devices already run it.
2. **File:** the `.bin` from the build (up to 3.9 MB; ESP32 builds are usually 1–2 MB). The platform checks it's
   an ESP32 firmware file, records its SHA-256 fingerprint and keeps it privately (the same private file store
   as checklist photos).
3. **What changed:** optional notes.

Each version can only be uploaded once. A new build needs a new version number.

## Sending it, in stages

Open the release. Every device is listed with the version it runs, where it is, when it last reported and how
this update is going.

1. **One bench device first.** Tick it and press **Send**. Check it updates and keeps reporting normally.
2. **A few pilot machines.** Leave them a day.
3. **Everyone else.** **Tick all shown not on this version**. Filter by organization to go customer by
   customer.

Each device gets the update at its next contact: within seconds when running, or within 15 minutes when parked.
An update waits up to **7 days** for a device that's switched off.

| Status | Meaning |
|---|---|
| Waiting for the device | Queued; the device hasn't been in touch yet |
| Sent, installing | The device has it; it downloads (~1–2 minutes on LTE Cat 1), installs and restarts |
| Updated | The device answered that it's running the new version |
| Failed | The device answered with a problem (e.g. the download was incomplete); it kept its old version |
| Expired | No answer within 7 days |

- **Cancel waiting** stops updates that haven't reached devices yet.
- **Retire release** (e.g. a build with a bug):
  - cancels its waiting updates;
  - stops it being sent or downloaded again;
  - devices already running it keep running it until you send them a newer version.
- **Undoing an update:** send the devices an older version. This is the same as any other update.
- **New choice wins:** a device waiting for one version that is then sent a different one gets the newer choice.

## Safety of an update (what our firmware will do)

- **Download only through the platform.** Each device gets its own download link, valid only for devices that
  were sent the update. With `DEVICE_KEY_SECRET` set, the link is also signed for that device, like commands.
- **Check before installing.** The device checks the size and the SHA-256 fingerprint from the command. A
  mismatch means the update isn't installed and is reported as Failed.
- **Two slots.** The ESP32 keeps the running firmware and installs the new one into the spare slot. If the new
  version doesn't start and reach the server, it falls back to the old one by itself (rollback).
- **Don't update mid-shift.** The firmware will wait until the engine is off before installing, so a machine never
  restarts its tracker while working.

## The firmware version on each device

- The device page (**Platform → device**) shows its firmware.
- Devices on the stock Telelogger don't report a version: they show "Not reported".
- Our firmware will add `FW=<version>` when it signs in, and the platform records it.

## For the firmware (technical)

- **Command** (in a reply, like other commands; [device-commands.md](device-commands.md)):
  `UPDATE=<version><TAB><bytes><TAB><sha256 hex><TAB><path>`.
- **Path:** `/hub/api/firmware/<release id>?d=<deviceId>&s=<signature>`.
  - Signature: first 16 hex characters of HMAC-SHA256(device key, `fw\n<deviceId>\n<release id>`), or `-` when
    signing is off.
  - The response is the binary.
  - Headers `X-Firmware-Version` and `X-Firmware-SHA256` are included.
  - A device that wasn't sent the update gets 403.
- **Answer** (`/hub/api/ack`):
  - after restarting: `ok=1` with a result such as `running vs-1.0.3`;
  - on a failure: `ok=0` with the reason.
  - Store the command id before restarting, so the answer can be sent after the restart.
  - The command is resent every minute until answered (up to 5 times), so ignore ids already run or in progress.
- **Version:** add `&FW=<version>` to the login notify (`EV=1`).
- **Code:** `platform/src/lib/firmware.ts` (tested).
- **Simulator:** `npm run simulate` behaves like this. It reports `--firmware` (default `sim-1.0.0`), and on
  UPDATE it downloads, checks the fingerprint, "restarts" and answers.
