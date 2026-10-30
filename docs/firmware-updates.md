# Firmware updates (over the air)

The platform side is built: staff can upload firmware builds and send them to devices in stages. The device side
(download, check, install, roll back) is in our own firmware since vs-0.2.2 (2026-10-27, `feat/cell-beam`), tested
on the desk through VS-lab. The stock Telelogger ignores the command, so sending one is harmless.

**Limits for now:** a device takes an update only while it's awake (engine running, or within 3 minutes of
stopping); a parked device gets it at its next wake, not at its 15-minute check-ins. Updates go over cellular only,
not Wi-Fi. A download takes about 7 minutes (1.8 MB as Base64, about 2.4 MB of cellular data).

## Which file for which device (2026-10-30)

Our firmware comes in two builds; a device must get an update made from the build it should run:

| Build | Version name | For |
|---|---|---|
| `bench-beam-obd` | `vs-0.4.0` | GPS & Telematics and Safety & Access Monitoring: tracking, engine data, beacon check-ins; sleeps when parked |
| `bench-beam-relay` | `vs-0.4.0-relay` | Safety & Access Control machines with the starter relay fitted; **never sleeps** (it would drain a parked vehicle's battery without a machine's charging) |

Updates work for devices already on vs-0.2.2 or later (earlier versions are updated by USB). Sending the other build
switches a device between them.

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

A device takes the update the next time it's **awake** (engine running, or just after stopping): within seconds if it's
running now. A parked device is offered it at each 15-minute check-in but doesn't act on it until it's next woken
(it's driven or the engine starts). It installs once the engine is off again. An update waits up to **7 days**.
(Until 2026-10-27 VS-lab gave up after 5 tries, which a parked device used up in about 75 minutes and showed as
Expired: resend those.)

| Status | Meaning |
|---|---|
| Waiting for the device | Queued; the device hasn't been in touch yet |
| Sent, installing | Offered to the device; once it's awake it downloads (about 7 minutes), installs after the engine stops and restarts |
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

## Safety of an update (what our firmware does)

- **Download in pieces, always.**
  - Cellular modems' built-in web commands (SIM7600, SIM7670) often fail on a ~1.5 MB file in one go. The production
    firmware hit this, and falls back to small pieces.
  - Ours goes straight to pieces: about 16 KB each, retrying a failed piece, and making pieces smaller when
    transfers keep failing.
  - Pieces are plain bytes (standard HTTP range requests), not Base64 text, which would use about a third more
    cellular data.

- **Download only through the platform.** Each device gets its own download link, valid only for devices that
  were sent the update. With `DEVICE_KEY_SECRET` set, the link is also signed for that device, like commands.
- **Check before installing.** The device checks the size and the SHA-256 fingerprint from the command. A
  mismatch means the update isn't installed and is reported as Failed.
- **Two slots.** The ESP32 keeps the running firmware and installs the new one into the spare slot. If the new
  version doesn't start and reach the server, it falls back to the old one by itself (rollback).
- **Don't update mid-shift.** The firmware waits until the engine is off before installing, so a machine never
  restarts its tracker while working.

## The firmware version on each device

- The device page (**Platform → device**) shows its firmware.
- Devices on the stock Telelogger don't report a version: they show "Not reported".
- Our firmware adds `FW=<version>` when it signs in (e.g. `vs-0.2.5`), and the platform records it.

## For the firmware (technical)

- **Command** (in a reply, like other commands; [device-commands.md](device-commands.md)):
  `UPDATE=<version><TAB><bytes><TAB><sha256 hex><TAB><path>`.
- **Path:** `/hub/api/firmware/<release id>?d=<deviceId>&s=<signature>`.
  - Signature: first 16 hex characters of HMAC-SHA256(device key, `fw\n<deviceId>\n<release id>`), or `-` when
    signing is off.
  - The response is the binary. **Download it in pieces:** send `Range: bytes=<start>-<end>`, or, if the modem's
    HTTP commands can't set headers, add `&o=<offset>&n=<length>` to the path. Either way the answer is
    `206` with that part and `Content-Range`. A range past the end of the file gets `416`.
  - Add `&e=b64` to get the part as Base64 text instead of raw bytes (still `206`, `Content-Range` in bytes of the
    file). Our firmware does: the SIM7670's HTTP commands don't pass all binary data through (a 1 KB block that
    started with zero bytes came back empty, desk test 2026-10-27). Costs a third more cellular data.
  - Suggested piece size: 16 KB, halved after 3 failed tries (down to 4 KB). Keep pieces in flash as they arrive
    (`Update.write`), so a long download doesn't need the whole file in memory.
  - When every piece is in, compare the whole file's SHA-256 with the command's before finishing the install.
  - Headers `X-Firmware-Version` and `X-Firmware-SHA256` are included.
  - A device that wasn't sent the update gets 403.
- **Answer** (`/hub/api/ack`):
  - after restarting: `ok=1` with a result such as `running vs-1.0.3`;
  - on a failure: `ok=0` with the reason.
  - Store the command id before restarting, so the answer can be sent after the restart.
  - The command is resent every minute until answered or expired (7 days; other commands stop after 5 tries), so
    ignore ids already run or in progress.
- **Version:** add `&FW=<version>` to the login notify (`EV=1`).
- **Code:** `platform/src/lib/firmware.ts` (tested).
- **Simulator:** `npm run simulate` behaves like this. It reports `--firmware` (default `sim-1.0.0`), and on
  UPDATE it downloads in 16 KB pieces, checks the whole file's fingerprint, "restarts" and answers.

## Compared with the production firmware (reviewed 2026-10-22)

`veristart-hardware-device` `src/ota_manager.cpp` (SIM7600) tries the whole file first. If that fails, it
downloads Base64 pieces from a custom endpoint (18 KB, shrinking to 6 KB), checks each piece's SHA-256 and
watches for the file changing mid-download. That is careful and the right idea.

What we do differently:
- **Pieces from the start, as raw bytes** (standard ranges): no failed first attempt, and no Base64 overhead (+33%
  cellular data).
- **The whole file's fingerprint**, from the signed command, is checked before install. The production firmware
  checks each piece against fingerprints from the same server.
- **Automatic rollback:** the new version must reach the server before it confirms itself; otherwise the ESP32
  goes back to the old one after a restart. No rollback call was found in the production code.
- **Later:** signed firmware images (ESP32 Secure Boot), so even a compromised server can't install its own
  firmware.
