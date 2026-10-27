# Hardware bring-up log (Freematics Model H, Y5725A32)

The working record for the device phase: what's proven, what's decided, what's open.

**Who updates it:** whichever Claude session does device work updates it at the end of each step, so the next session has the full context. Updates are committed to `main` (docs only), so every session reads one copy; the work itself stays on its branch until merged.

**Last updated:** 2026-10-27

---

## Status at a glance

| Area | Status |
|---|---|
| Wi-Fi upload to VS-lab | ✅ Works (`bench-nobt`; TLS on the ESP32 runs out of memory with Bluetooth on) |
| Cellular registration on 12 V | ✅ Works. On USB the modem used to reboot during network search; it held on USB on 2026-10-24 but don't rely on it |
| Cellular HTTPS direct to Vercel | ❌ Impossible on this modem firmware (no SNI → Vercel `421`), see below |
| Cellular via **Soracom Beam** | ✅ Works. Y5725A32 reports to VS-lab every few seconds (`feat/cell-beam`) |
| GPS | ✅ The board's own GPS chip works (`GNSS_STANDALONE`, `1c461d7`): `GNSS:OK(I)`, a fix indoors, position in every upload. The modem has no GPS. Outdoor accuracy to check in car test 1 |
| Engine on/off from OBD RPM | ⏳ Car test pending (`bench-beam-obd`) |
| Engine on/off from supply voltage, no OBD | ✅ On the desk: `bench-beam` sends 0x24 from A0 in every upload, timing unchanged (`a742e40`). Values against a multimeter in a car still to check (car test 2) |
| Store-and-forward / location history replay | ⏳ On hold. **Core requirement** (see below) |

**Build on the device now:** `bench-beam-obd` with store-and-forward, final engine-off reading, GPS date, device commands and operator alerts (`a4648c2`), no sleep while moving and restart/sleep reasons (`4d495a4`), battery voltage while parked (`6150144`), field-test-2 fixes (`0b87e07`: unsent readings kept on the SD card through
sleep, SIM7670 upload fixes, faster modem recovery, failure logging), no sleep while the engine idles (`e4b6402`), frozen engine readings = engine off (`cfe7645`), and
**vs-0.2.6** (vs-0.2.5 `35d3d31` plus the offered-readings log line): version on sign-in, log file on the SD card, restart reports, updates over the air (two
firmware slots: the partition table changed), fuel level and odometer, 10 s upload result wait. **Kept for the first car test:** the CX-9 has an ECU, so OBD connects once and the retry cost doesn't apply.

---

## Findings (with evidence)

### 1. SIM7670G never sends TLS SNI

**What it means:** cellular HTTPS straight to Vercel is impossible on this modem firmware.

- **Modem:** SIM7670G-LNGV, firmware `2368B01SIM767XM5A` / `SIM767XM5_B01V03_240309`.
- **The setting is accepted but does nothing.** `AT+CSSLCFG="enableSNI",<ctx>,1` returns OK and reads back as 1, but is never applied. `AT+CSSLCFG="sni",…` returns ERROR.
- **The certificate proves no SNI was sent:**
  - With only GTS Root R1 (the SNI chain) loaded, the handshake fails: `CCHOPEN` error 15 / HTTP 715.
  - With only ISRG Root X1 loaded and `ignorecertCN=1`, it succeeds. That means the modem received Vercel's no-SNI certificate, `CN=no-sni.vercel-infra.com`.
- **Every request returns `421 Misdirected Request` (`X-Vercel-Mitigated: deny`).** This happens over both the `AT+HTTP…` service and the CCH (raw socket) service.
- **Vercel-specific:** many AWS endpoints (e.g. an ALB) serve a default certificate without SNI. Vercel refuses.
- **Bug report:** `docs/simcom-sni-report.md`, ready to send. ⏳ Craig to send it to SIMCom or the distributor.
- **Custom PCB risk:** before the Ignition Protector board's cellular module is locked, run the same certificate test on it (e.g. a SIM7600).

### 2. Soracom Beam is the lab workaround

- **Console:** SIM IMSI `295050915750471` is in group `vs-lab-beam`. That group has a Beam **Website entry point** that forwards HTTPS to `vs-lab-platform-tpj9.vercel.app:443`.
- **Firmware:** `CONFIG_SERVER_HOST="beam.soracom.io"`, port 80. The library change in `CellHTTP` chooses `http`/`https` by port, because the SIM7670 branch used to hard-code `https://`.
- **No Wi-Fi in Beam builds:** there's one server host for both links, and `beam.soracom.io` only works from a Soracom SIM.
- **Lab only:** it ties devices to Soracom (Veristart also uses Telus/Rogers), and it's plain HTTP on the device side.
- **Production path:** TLS on the ESP32 (BearSSL/mbedTLS buffers in PSRAM), with the modem as a plain data pipe.

### 3. Freematics beep

- **What it means:** one short beep is `[CELL] In service`. On the SIM7670, "connected" means only `AT+HTTPINIT` succeeded; the server isn't contacted at that point.
- **Repeating every 2–3 minutes** means 5 failed sends → teardown → reconnect. That was the 421 loop before Beam.
- **With uploads working:** one beep at connect and no repeat.

### 4. Engine detection on real data

- **Telelogger accelerometer data:** averages per data interval, in g, with gravity removed. At rest it sends `0;0;0`.
- **Old bug, fixed (`fix/engine-vibration`, live since 2026-10-25):** the check was `|g − 1| ≥ 0.05`, so a still device read as running. Now it's `hypot(accel) ≥ 0.05`, plus a new "Unknown" status.
- **Vibration is weak:** averaging smooths out an idling engine's shake, and a machine being transported reads as running. Use it only as a last resort.
- **Supply voltage (PID 0x24):** stock Telelogger only sends it with `ENABLE_OBD`. On board type 15 (Model H, boot log `TYPE:15`) it's `analogRead(A0)*45/4095`, with no co-processor involved, so our OBD-off builds now send it too (`a742e40`).
  - Desk test, `bench-beam`, USB power: 0x24 in 59 of 59 uploads, 3.51–3.69 V. Sampling every 1 / 2 / 5 s and 59 uploads in 3 min, all answered OK: the same as before.
  - First sample 5.9 s after boot instead of 3.8 s: OBD-off builds now ask the co-processor for the board type at boot.
- **Cost of OBD with no ECU:** the build retries `obd.init` every cycle (a cycle takes about 2.9 s). First sample 14.5 s after boot instead of 3.8 s, and sampling drops from every 1–2 s to every 2.9 s; 5 s intervals are unaffected. So OBD stays off in `bench-beam`.
- **USB reads 3.5–3.7 V:** `fix/battery-floor` (`940d40f`) ignores readings under 8 V as "not on machine power": no voltage engine reading, and they don't count for the low battery warning. Not yet applied in the tamper watchdog (open item 11).
- **Production data to clean up:** false CX-9 engine sessions from the 2026-10-24 desk run. Delete only after Craig reviews the exact rows.

### 5. Telelogger buffering (stock source)

- **RAM ring buffer:** 32×256 B, or 1024×384 B with PSRAM. That's about 0.5–2.5 min of backlog, or about 15–85 min with PSRAM. Oldest slots are overwritten.
- **Upload order:** newest first (`getNewest`).
- **Data that's dropped:**
  - a failed send is purged, not put back in the buffer;
  - the whole buffer is purged on standby and on high temperature.
- **SD card logging is write-only:** nothing replays from it.
- **PSRAM is on in our builds:** every boot logs `PSRAM:8MB`, and all our envs set `BOARD_HAS_PSRAM` (the stock `platformio.ini` didn't), so the 1024×384 B buffer applies.
- **VS-lab timestamps:** since 2026-10-25 VS-lab dates samples by **when they were taken** (`recorded_at`: GPS time `0x10`, else uptime); late backlogs are stored as history only. Telelogger sends no GPS date (`0x11` is never sent). Before, arrival time put backlogs in the wrong place (Craig's "fan" on the first drive). See [store-and-forward.md](store-and-forward.md).

---

## Decisions

| Date | Decision |
|---|---|
| 2026-10-24 | Bluetooth is required in deployment. `bench-nobt` is only for early Wi-Fi tests |
| 2026-10-24 | Soracom Beam for cellular in the lab. ESP32-side TLS is the production direction |
| 2026-10-25 | `bench-beam` keeps OBD off (retry cost). `bench-beam-obd` is for vehicles with an ECU |
| 2026-10-25 | **Location history with store-and-forward is a core requirement.** Current location alone is not a success. Work is on hold for now; raise it again for ESP32 TLS, custom PCB storage choice and pilot readiness |
| 2026-10-25 | A0 supply voltage only on board type 15, the only type checked (upstream uses A0 for every type above 12). OBD-off builds start the co-processor link at boot just to read the board type |
| 2026-10-25 | No multimeter check of the device's voltage reading for now: the readings look right (Craig). Revisit if voltage-based engine on/off misbehaves |
| 2026-10-25 | Supply floor 8 V. USB reads about 3.6 V and never more than about 5 V; a 12 V system the device runs on reads 10.5 V or more even when flat, and rarely under 9.5 V while cranking; below 8 V the machine couldn't start anyway |

---

## Firmware to-do for the next device session (written 2026-10-25, from the evening CX-9 drive)

Context: the CX-9 runs `bench-beam-obd`; OBD works (`obdRpm` in uploads). On the evening drive the last ~4 minutes
(18:32–18:36 NDT) never reached VS-lab (weak signal, −83 dBm; the firmware throws away readings it can't send), and a
4–5 minute dead zone earlier left a gap in the track. VS-lab side is done: readings are dated by GPS time
(`recorded_at`), backlogs are accepted as history, gaps are drawn dashed, engine times come from reading times, and a
sign-off (logout) ends the engine-on period. In order:

1. ✅ **Keep and resend readings (store-and-forward step 2)**, 2026-10-25, `feat/cell-beam` `bdbf385`, on the device now
   (`bench-beam-obd`):
   - readings stay in the buffer until VS-lab answers 200 (a 4xx drops them; a retry can't help); a failed batch is
     resent; oldest first; up to 15 readings per upload once the oldest has waited 15 s (`VSLAB_BATCH_SECONDS`), so
     about one upload every 15–20 s instead of one per reading; 5 s pause after a failed upload;
   - before signing off for sleep it sends what's left. Not kept across sleep: the firmware restarts on wake
     (`RESET_AFTER_WAKEUP`), clearing memory, so a machine parked out of coverage still loses its last unsent readings
     (step 3 of the plan, the memory card, fixes that);
   - desk test with a pretend 80 s dead zone (test switch `VSLAB_TEST_OUTAGE`): 45 readings recorded, 45 delivered,
     the backlog in two uploads (`OK 15`, `OK 9`) right after; the last 3 sent before sign-off;
   - ✅ **VS-lab ignores repeats** (2026-10-25, cloud session): a reading with the same uptime (PID 0) as one stored from
     the same device in the last 24 h, taken within 60 s of it, is skipped (`DUPLICATE_RULES` in `ingest.ts`, tested);
     the reply is still 200 (`OK <new readings>`, e.g. `OK 0` for a full repeat), which the firmware counts as sent.
     Uploads with up to 15 readings (several `0:` timestamps per body) were already handled by the parser.
2. ✅ **Final "engine off" reading before sleeping**, 2026-10-25, `feat/cell-beam` `b3c0ec9`, on the device now:
   - on `[OBD] ECU OFF` the reading in progress is finished as an explicit RPM 0 (PID 0x10C) with voltage and position,
     and sent (with anything still waiting) before sign-off;
   - **differs from the plan:** at the stationary timeout no RPM 0 is added. The last real reading is sent instead
     (item 1), because a machine idling in place would get a false "off". VS-lab: a sign-off there may not mean the
     engine stopped;
   - can only be checked with a real engine computer: ⏳ in the car, switch off and look for the RPM 0 reading right
     before the sign-off.
3. ✅ **GPS date**, 2026-10-25, `b3c0ec9`: PID 0x11 (`gpsDate`) in every GPS reading, format DDMMYY (`251026` = 25 Oct
   2026), next to `gpsTime`. Desk check: in every reading, uploads accepted. ✅ VS-lab uses it (2026-10-25,
   `sample-time.ts`, tested): date + time give the exact moment, up to 30 days old; an impossible or out-of-range date
   falls back to the time-of-day rule (stock firmware).
4. **Unplug/replug recovery** (left from car test 1): unplug while running, plug back in; check it reconnects on its
   own and VS-lab raises the tamper "power interrupted" incident.
5. Then **merge `feat/cell-beam`** (item 8) and send the SIMCom report (item 9).

6. ✅ **Operator alert beeps and device commands**, 2026-10-25, `feat/cell-beam` `a4648c2`, on the device now:
   - commands from replies to uploads and sign-ins, run once (last ID in NVS), answered at `/hub/api/ack`; signatures
     checked when the build has a key (`VSLAB_DEVICE_KEY`), unsigned accepted without one (VS-lab sends unsigned:
     `DEVICE_KEY_SECRET` isn't set);
   - `ALERT` patterns every 30 s while the engine runs, stopped by `ALERT=none` or sleep; `BEEP`, `REPORT`, `RESET`;
     other commands answer "not supported yet"; routine "connected" beeps removed;
   - tested with real VS-lab commands: #5 BEEP=3, #6 REPORT, #7 BEEP=2, all run and answered;
   - ⏳ car: an `ALERT` from VS-lab while the engine runs (machine Access-Controlled, nobody checked in);
   - ⏳ before real machines: turn signing on (`DEVICE_KEY_SECRET` in Vercel, then build each device with its key).

7. ✅ (done 2026-10-27, see "Firmware updates, log file, restart reports" below) **Log on the memory card + restart reports** (Craig, 2026-10-26): copy diagnostic messages to `/LOG/<n>.TXT` on
   the card (one file per start-up, timed, size-capped), record the restart reason (`esp_reset_reason()`), add
   `&RST=<reason>&BOOT=<n>` to the login notification, and post the previous start-up's last log lines to
   `/hub/api/diag/<DEVID>`. Spec: [device-diagnostics.md](device-diagnostics.md). VS-lab side is done.

8. ✅ in code, ⏳ to check in the car (2026-10-27, with OBD fuel level 0x2F) **Odometer for maintenance and checklists** (Craig, 2026-10-26; low priority): every checklist now asks for the hour
   meter (or the odometer on on-road vehicles), filled in from the vehicle when the device reads it. Hours already
   come from J1939 (0x301). Add the odometer: OBD-II PID `0xA6` (only on newer vehicles: check the supported-PIDs
   bitmap, don't poll it otherwise) sent as `0x1A6` in **km** (the PID gives 0.1 km), and J1939 SPN 917 (or 245) as
   `0x30B` in km. Send it about once a minute, not with every reading. VS-lab side is done (`machines.odometer_km`).

9. **Starter relay for Safety & Access Control** (Craig, 2026-10-26): copy the relay from Veristart's production
   firmware (`Veristart/veristart-hardware-device`, `include/user_setup.h`, `include/device_pins.h`,
   `src/ble_manager.cpp` `applyRelayPolicy`). Full spec: [starter-relay.md](starter-relay.md). VS-lab side is done.
   Steps, each tested on the bench with a relay module (or an LED) on the external socket:
   - a. **Relay output:** GPIO26 output, LOW at power-up; GPIO12 HIGH (socket VCC); LED GPIO4 mirrors the relay.
     Stop reading GPIO26 as `PIN_SENSOR2` in relay builds. New env `bench-beam-relay` (flag `VSLAB_RELAY=1`).
   - b. **MODE** enforced: Unlocked closed, Locked open, Access-Controlled open unless allowed; the offline fallback
     (`<offline mode>` after `<hours>` without contact). Answer the command as now.
   - c. **ALLOW / REVOKE** with the start window and break timers (engine state from RPM, as the alerts use).
   - d. **Stay awake while parked (relay builds):** no `standby()`; Bluetooth on; modem stays registered and the
     device checks in every **30 s** (`VSLAB_RELAY_POLL_SECONDS`), so a QR check-in reaches it within about a
     minute. Measure the parked current with the battery check-in (`&BV=`) and note it here.
   - e. **ACCESS list + beacons:** keep the list in NVS; scan for `VS-BEACON-*` (Veristart's 70 cm / RSSI rules);
     an approved beacon closes the relay like an ALLOW (break 0: the beacon must stay near); report each start at
     `/hub/api/access`, queued if there's no signal.
   - f. **Operator app passes:** advertise as `VS-<device ID>`; service `7f3c0001-6a2b-4b4e-9b1e-56a5c0de0001`, characteristic
     `7f3c0002-…0001` (write with response, then the app reads `OK` / `EXPIRED` / `BAD_SIG` / `LOCKED` / `NOT_YOURS`) takes an unlock pass
     `U1|<operator>|<check-in>|<from>|<until>|<sig>` ([operator-app.md](operator-app.md)); check the HMAC with the device
     key and the window with GPS time; act as ALLOW; check-in 0 = offline pass → report at `/hub/api/access?b=APP`.
   - g. **Session hold (lunch breaks, Craig 2026-10-27; [operator-app.md](operator-app.md)):** remember the check-in that
     last unlocked the machine (ALLOW id + operator, or the U1 pass's), its hold minutes (ALLOW 4th field) and the engine
     stop time, in RTC memory/NVS; a newer ALLOW, pass, beacon start, REVOKE or Locked drops it. Nonce characteristic
     `7f3c0003-…0001` (read → new random 16 hex each read, kept per connection). On `R1|op|checkin|until|hold|proof`:
     `NOT_HELD` unless it's the remembered check-in and operator; `EXPIRED` if GPS time > until or > stop + hold;
     derive key = HMAC-SHA256(device key, `session\n<device>\n<op>\n<checkin>\n<until>\n<hold>`) as hex, check proof =
     HMAC-SHA256(that hex, `resume\n<nonce>`)[0:16] else `BAD_SIG`; `LOCKED` in Locked; otherwise `OK` and treat the
     connection as the operator: close the relay while that phone stays connected **and near** (RSSI ≥ about −70 dBm,
     measure in a cab; `TOO_FAR` while it isn't), so a phone in the site trailer doesn't enable the machine. While the
     engine runs on it, keep the relay closed as for ALLOW. Report each resume once (first `OK` after a stop) at
     `/hub/api/access?op=&c=&t=&sig=`, queued without signal. Allow 3 connections at once and a fixed (public)
     Bluetooth address, so phones can reconnect by themselves.
   - Install on a test machine only with the starter-only wiring (starter-relay.md → Safety rules).

Rules as before: mark changes `// VSLAB:`, keep Bluetooth on in deployment builds, build/flash on Craig's PC, update this
file after each step.

## Field test 1 follow-up (2026-10-26, CX-9 drive; desktop session)

The report: after a boot the device reported for a while, then went quiet in good coverage (twice); once it restarted
by itself after ~5 min, once not within 14 min; beeps with the engine off at 11:16; a stale position shown as live.

**What the firmware can do on its own** (checked in the source): the ESP32 only restarts by itself when it **wakes from
sleep** (`RESET_AFTER_WAKEUP`), after a crash/watchdog/brownout, or on a restart command. "Quiet, then restarted with
nobody touching it" therefore most likely means **it went to sleep while driving and a bump woke it** (wake needs 0.4 g
of motion, so a smooth drive or parking can keep it asleep: the 14-minute case). The sleep trigger that fits a moving
car: OBD builds sleep when the engine computer misses 3 readings in a row **and** a reconnect fails (`[OBD] ECU OFF`),
regardless of movement. Not proven yet (no serial log from the car). The 11:16 beeps: with the engine computer silent,
`engineRunning()` fell back to voltage, and 14.4 V right after a drive read as "running".

**Changed** (`feat/cell-beam` `4d495a4`, on the device now, `bench-beam-obd`):
- no sleep on `ECU OFF` while GPS or motion shows movement in the last 30 s: keep tracking, keep retrying OBD;
- OBD builds: "engine running" (for alert beeps) = engine computer answering and RPM ≥ 300; voltage isn't used;
- **for VS-lab (cloud session):** the first sign-in after a boot carries `&RST=` (`power_on` = plugged in or reset,
  `software` = woke from sleep or restart command, `crash`, `watchdog`, `brownout`, `external`, `unknown`), and every
  sign-off carries `&WHY=` (`stationary`, `ecu_off`, `bluetooth_off`). Store them on the device events; the tamper
  watchdog can then tell a wake or crash from an unplug (`RST=software` after `WHY=…` isn't tampering). Desk check:
  `power_on`, `stationary`.
  - VS-lab (2026-10-26): the `RST=` names are now understood (`src/lib/restart-reasons.ts` maps `power_on`, `software`,
    `crash`, `watchdog`, `external` to its own keys; `software` counts as normal, not tampering). `WHY=` not stored yet.

**Answers to the report's requests:**
1. Bench reproduction: the drive conditions (engine computer, motion) don't happen on the desk. Next drive, record
   the serial log in the car (laptop on the passenger seat; Claude on the PC records it).
2. Restart reason: done (`&RST=`), plus the sleep reason (`&WHY=`).
3. Watchdog: the firmware sets a 600 s task watchdog **without** reset (`esp_task_wdt_init(600, 0)`), so a stuck
   network task isn't restarted by it. Recovery from network trouble is the existing logic: 5 failed uploads →
   modem off, re-init (with a 3-minute pause if that fails). Revisit with the car log.
4. Stale position: the firmware already sends a position only with a new GPS fix time, plus satellites and HDOP. The
   frozen map and 30 km/h are VS-lab keeping the last snapshot (item 6 of the report, VS-lab side).
5. Engine rule after boot: the check-in state lives in VS-lab, not the device; a booted device is quiet until VS-lab
   sends `ALERT=…`. The device-side "engine running" is now RPM-only in OBD builds (above). VS-lab should send
   `ALERT=none` when it sees the engine stop.
6. VS-lab: stale position and conflicting status lines: cloud session.

## Battery voltage while parked (2026-10-26, Craig's request; desktop session)

**Why:** a battery drained while parked (by our device or other loads) is only noticed at the next start today: the
15-minute parked check-ins carried no voltage, so VS-lab only saw the battery just after stopping and just before
starting.

**Firmware (done, `feat/cell-beam` `6150144`, on the device now):** each parked check-in (every 15 min, a sign-in
`EV=1` then a sign-off `EV=2`) carries `&BV=<centivolts>`, e.g. `&BV=1262` = 12.62 V, read the same way as PID 0x24
(A0 on board type 15). Desk test with a 60 s interval: 3.68 / 3.69 V on USB; each check-in keeps the modem on about 13 s.

**VS-lab (done 2026-10-27, cloud session):** `BV` on notify is stored as a reading without a position (dated by
arrival, `fields.parkedCheckIn = 1`) and as the device/machine's latest voltage, so the machine page's Battery voltage
chart shows the overnight / weekend trend; it feeds the low battery warning as an **engine-off** reading (not if VS-lab
still has the engine running); the 8 V floor still applies (a desk device on USB sends ~3.6 V). Code:
`recordParkedBattery` in `platform/src/lib/telemetry/ingest.ts` (tested in `battery.test.ts`).

**Our device as a load:** while parked it stays partly awake (watching for motion) and powers the modem every
15 minutes. The parked voltage trend will show its effect; machines parked for weeks may need longer check-in gaps.

## Field test 2 (2026-10-27, CX-9 drive with the laptop recording; desktop session)

About 14 minutes from Craig's home, mostly at 90–100 km/h, then parked (08:14–08:33 local, NDT = UTC−2:30). Build on the
device: `bench-beam-obd` `6150144`. Serial log kept on Craig's PC (`%LOCALAPPDATA%\Temp\claude-vslab-build\drive2.log`);
the SD card also holds the whole drive (`/DATA/77.CSV`).

**What worked:**
- **No sleep while driving.** The device tracked the whole drive (GPS every second, 12 satellites, OBD answering the
  whole time; no `ECU OFF`). The field-test-1 fix holds.
- Boot reason on the log: `power_on` at the start, `software` after the wake (as designed).
- The server answered every upload it received in ≤ 0.5 s (Vercel: `/hub/api/post` time to first byte, max 475 ms).

**❌ New problem 1: uploads fail while driving.** At rest at the start, 5 uploads in a row got `OK`. From the moment the car
was moving (08:15:34) the pattern repeated four times:
1. after a full modem start, 1–2 uploads get `OK`;
2. the next one gets `[HTTP] No response` after ~7 s, the firmware declares `Not in service` and re-activates (a few seconds);
3. the next upload fails the same way; on the second re-activation the modem stops answering (`No supported module`, ~70 s);
4. the firmware switches the modem off and **waits 3 minutes** before starting again.

So about 2 uploads (30 readings) got through every 5 minutes against 300 readings made. Signal was fine throughout
(RSSI −71 to −93 dBm, same operator 302720, same IP). Vercel's request counts match the device's `OK`s, apart from one
upload at 10:55 UTC that the device logged as failed but the server received (the device later resent it and got
`OK 0`: nothing new, so the dedupe worked). So the uploads mostly don't reach the server: the cause is between the modem
and Soracom (modem HTTP stack or cell handover at speed), not VS-lab. Not proven which yet.

**❌ New problem 2: the backlog was lost.** Parked at 08:28; at 08:31:32 `Stationary for 182 secs` → standby with
**763 readings still waiting** (the modem was in its 3-minute pause, so the flush before sign-off couldn't send). A bump
woke it at 08:32:40, and the restart on wake (`RESET_AFTER_WAKEUP`) cleared memory. VS-lab therefore has only the first
~2.5 minutes of the drive (readings up to device time 164 s) and the restart. The readings are still on the SD card.

**❓ To check with Craig:** after the restart the engine computer reported 714 RPM at 12.68 V (Mazda's smart charging can
idle near 12.7 V). If the engine was idling when the device went to standby, stock Telelogger signs off after 3 minutes
without movement **even with the engine running**, and VS-lab ends the engine session at the sign-off.

**Firmware fixes (done with Craig's go-ahead, `feat/cell-beam` `0b87e07`, on the device now; details in
`firmware/README.md`):**
- a. ✅ **Unsent readings survive sleep:** before sleeping, the backlog goes to `/VSLABQ.TXT` on the SD card; after the
  restart it's sent first (progress kept in NVS). On wake the restart waits for that save. Desk test: 39 readings saved,
  all 39 delivered after the restart (`OK 15`, `OK 15`, `OK 9`).
- b. ✅ **Likely cause of the failed uploads, fixed:** the modem library wrote the upload body without checking that the
  modem had asked for it (`DOWNLOAD`), and gave the whole round trip 5 s before asking for the reply. A late prompt
  turns the body into AT commands, which fits "upload fails, then the modem stops answering". Now: body only after
  `DOWNLOAD`, then up to 20 s for `+HTTPACTION:`. Not proven until the next drive.
- c. ✅ **Faster recovery:** a modem that stops answering is powered fully off before restarting; after a failed modem
  start the wait is 15 s, 30 s, 1 min, then 3 min. Seen on the desk: the modem didn't answer at boot (70 s), came back
  on the 15 s retry.
- d. ✅ **Logging for the next drive** (always on): a failed upload logs the modem's reply to the failing step and the
  network state (`AT+CPSI?`, e.g. `LTE,Online,302-720,…,EUTRAN-BAND66,…`).
- e. ✅ **No sleep while the engine idles** (`e4b6402`): Craig confirmed the engine was left idling after parking (he
  thought about a minute; the log shows the engine computer answering until standby at 08:31:32 and 714 RPM at 08:33,
  so likely longer). OBD builds now skip the 3-minute stationary sleep while RPM ≥ 300; ignition off (engine computer
  quiet) still sends the device to sleep. Not testable on the desk (no engine computer): check on the next drive.

**Next drive:** same set-up (laptop recording). Check that uploads keep getting `OK` on the move; if not, the new log
lines say why. Also idle 3+ minutes after parking (the log should say `staying awake`), then switch off: the device should sign off
with `ecu_off` and any backlog should be saved and sent after the wake.

## Field test 3 (2026-10-27, CX-9, laptop recording; desktop session)

About 9 minutes of driving from home, then parked with the engine idling for 3+ minutes, then switched off
(09:31–09:44 local). Build: `bench-beam-obd` `e4b6402`. Log: `%LOCALAPPDATA%\Temp\claude-vslab-build\drive3.log`.

**Uploads on the move: fixed in practice.** 44 uploads got `OK`, 7 failed, and **every failure recovered on the next
try** (5 s later), with the backlog (up to 47 readings) cleared within seconds. No `Not in service`, no modem restart,
no 3-minute pause, no readings lost (field test 2: 2 uploads per 5 minutes and 763 readings lost).
- Each failure was the same: the request went to the modem, then **no `+HTTPACTION` result within 20 s**, with an empty
  modem reply. The retry stored 15 new readings each time (`OK 15`, not `OK 0`), so the failed requests never reached
  VS-lab: they're lost between the modem and Soracom. All 50 requests Vercel saw were answered 200.
- Network state at each failure (`AT+CPSI?`): LTE online, operator 302-720, RSRP −110 to −116 dBm, with the serving
  band changing between failures (66 → 7 → 4): likely moments of cell change. Signal never dropped out.
- Possible tweak (not done): a 10 s wait instead of 20 s would halve each stall; a normal round trip takes ~2 s.

**Idling: fixed.** Parked ~09:40:18; at 09:43:18 (3 min) the log shows `[OBD] Not moving, engine running: staying
awake`, and uploads continued every ~20 s at 698–717 RPM until the recording ended.

**Not captured:** the switch-off itself. The recording was stopped about 30 s after the last log line (09:44:08, engine
still at 717 RPM), so the `ECU OFF` → sign-off (`WHY=ecu_off`) and the save of any backlog weren't seen. Vercel shows the
uploads stopping at about 12:15 UTC; no sign-off request was seen in the first minutes after (may be reporting delay).
Next drive: keep recording for 1–2 minutes after switching off.

## Frozen engine readings after switch-off (2026-10-27, CX-9; desktop session)

**Problem (Craig, in the car):** engine clearly off, VS-lab still showing "Running". The serial log showed the CX-9's
engine computer **still answering after switch-off, with frozen values**: exactly 699 RPM every reading, load 18 %,
throttle 11 %, while the supply fell from 14.3–14.7 V (idling) to 12.5–12.8 V. While really idling, RPM varied every
reading (695–717). So OBD never failed (no `ECU OFF`), "engine running" stayed true (no sleep) and VS-lab kept the
engine on. The "714 RPM at 12.68 V" after the wake in field test 2 was the same thing: Craig had switched off.

**Fix (`feat/cell-beam` `cfe7645`, on the device):** 12 identical non-zero RPM readings in a row while not moving
(about a minute parked) = engine off: the reading becomes the RPM 0 "engine off" reading, then sign-off (`WHY=ecu_off`)
and sleep. **Checked in the car, engine off:** after a restart it sent the readings saved on the SD card before its last
sleep, then `[OBD] Engine readings frozen (696 RPM, unchanged): engine off` → `ECU OFF` → sign-off → sleep (~40 s after boot).

**For VS-lab (cloud session):** the 11 frozen readings before the "engine off" reading still say ~700 RPM, so a session
ends about a minute late. Optional server-side guard: treat a run of identical non-zero RPM values as not running.

**Drive 4 (same trip, before the fix was checked):** uploads failed more often on this route (22 failures, 61 OK), all
recovered, backlog up to ~150 readings; the readings still waiting at the end were saved to the SD card at sleep and
delivered after the restart above. The laptop log stopped at 10:33 because the laptop went to sleep (keep-awake must be
renewed for each recording).

## Firmware updates, log file, restart reports (2026-10-27, desk; desktop session)

Built on `feat/cell-beam` (`e0e0299`, `35d3d31`; details in `firmware/README.md`), on the device as **vs-0.2.5**:

- **Version on sign-in** (`&FW=`): VS-lab's device page shows which firmware each device runs.
- **Log file on the SD card** (`/LOG/<start-up>.TXT`, timed lines) and **restart reports**: after each start-up the
  previous start-up's last lines go to VS-lab (Platform → device → Restart reports). Desk: 3–16 KB reports delivered.
  A 12.8 KB report first failed (modem `ERROR`): bodies are now sent to the modem in 1 KB parts.
- **Updates over the air**, tested through VS-lab (releases vs-0.2.1, vs-0.2.3, vs-0.2.4-rollback-test):
  - vs-0.2.1 (raw pieces) **failed**: the SIM7670's `AT+HTTPREAD` drops some binary data (one 1 KB block, starting
    with zero bytes, came back empty every time) and counts what's been read, so a part can't be re-read. VS-lab now
    serves pieces as Base64 on request (`&e=b64`, `main` `a561724`, deployed), as Veristart's production firmware
    does. vs-0.2.1 can't be installed (its own download code is the old one): **retire it** on its release page.
  - vs-0.2.2 → **vs-0.2.3**: downloaded in 406 s (1.79 MB, no failed piece), installed (engine off), kept itself
    once it reached VS-lab and answered "running vs-0.2.3". Readings made during the download waited in memory
    and were all sent before the restart.
  - **Rollback**: vs-0.2.4-rollback-test never confirms itself; 2 minutes after starting it went back to vs-0.2.3
    by itself. It had already answered "running" (VS-lab shows that update as Updated): fixed in vs-0.2.5, the
    answer now waits until the new version has kept itself.
- **Fuel level (0x2F) and odometer (0xA6 → `0x1A6` km, once a minute when listed)**: ⏳ check in the CX-9.
- **Upload result wait 10 s** (was 20 s): ⏳ watch on the next drive.

**Open (firmware):** commands, including updates, aren't run during the 15-minute parked check-ins (only when
awake); updates over Wi-Fi.

**Drive 5 (2026-10-27, CX-9, vs-0.2.5, laptop recording; `drive5.log`):** about 9 minutes of driving (17:10–17:19
local), then switched off.
- Uploads: 37 `OK`, 1 failure (the modem refused the URL step with `ERROR`; next try 5 s later `OK`). No 10 s waits.
- Engine off: `Engine readings frozen (876 RPM, unchanged): engine off` → sign-off → sleep about 40 s after
  stopping. The restart report of the previous start-up was delivered at the start.
- ❌ No fuel level and no odometer arrived. **Cause found the same day (not the car):** the CX-9's engine and
  transmission units both answer the "which readings do you offer" question, and upstream Telelogger kept only the
  last answer. With the transmission's list, fuel level and the odometer looked unsupported, so they weren't asked
  for (Craig: Veristart's production firmware reads the CX-9's fuel level). Ignition-on checks: vs-0.2.6 logged
  `Offers fuel level: no, odometer: yes` on one connection and `no, no` on the next; the odometer read
  **81,033.2 km**. A second upstream bug (`idx[-1] = 0` in `processOBD`) zeroed the odometer's timer, so it went
  with every reading. Both fixed in **vs-0.2.7** (`421cde1`: lists combined; not yet on the device).
- ⏳ **vs-0.2.7 goes to the CX-9 over the air** (the laptop was disconnected): upload `vs-0.2.7.bin` at Platform →
  Firmware, send to Y5725A32; the device takes it the next time it's awake (engine running), installs it after
  the engine stops. Then check: log line `Offers fuel level: yes, odometer: yes`, `0x12F` and `0x1A6` (about once a
  minute) in the uploads. The device runs vs-0.2.6 now.

## Open items (in order)

1. ✅ **Merge `fix/engine-vibration`** (`be90819`), 2026-10-25 with Craig's go-ahead: merged as `f87ac2f`, checks passed (271 tests), deployed (`dpl_CZFYtQG2xtw8CFM5STwFbgJcUnAD`, READY). The deploy's migration step ran without errors ("Database is up to date"), and no new runtime errors since. `fix/battery-floor` merged next, also with Craig's go-ahead (see item 4).
2. **Clean up the false CX-9 engine sessions.** List the rows for Craig, delete only after approval, then recalculate the engine state.
3. ✅ **A0 voltage in OBD-off builds** (`feat/cell-beam`, `a742e40` code, `84f5484` docs), 2026-10-25:
   - OBD-off builds send 0x24 from `analogRead(A0)*45/4095` in centivolts, on board type 15 only (see Decisions); marked `// VSLAB:`;
   - desk check with `bench-beam`: 0x24 in every upload and timing unchanged (Findings 4);
   - engine "off" in VS-lab: ⏳ Craig to confirm on the Fleet page (live `main` reads 3.5–3.7 V as off by voltage).
4. ✅ **`fix/battery-floor`** (VS-lab, `940d40f`), 2026-10-25. Merged and deployed with Craig's go-ahead (`d5b1cc7`, checks passed, 273 tests):
   - floor 8 V (see Decisions), one constant (`ENGINE_THRESHOLDS.machinePowerMinVolts`) used by `detectEngine` and `battery.ts`;
   - tests with the real 361/365/369 cV values and the 7.99 / 8.00 V boundary; `npm run check` passes (267 tests);
   - merge after `fix/engine-vibration`: on its own, desk readings would fall through to the old vibration rule (running). A trial merge of the two is clean.
   - also on this branch (`8a14d5c`): the tamper watchdog notes a reading under the floor as "Was not on machine power" instead of "Battery was low: may have run flat" (item 11).
5. ✅ **GPS**, 2026-10-25 (`feat/cell-beam`, `1c461d7`):
   - the SIM7670G-LNGV modem has **no GPS**: every GNSS command (`AT+CGNSSPWR`, `AT+CGNSSINFO`, `AT+CGPS`, `AT+CGNSINF`) answers ERROR; only `AT+CLBS` (cell-tower location) exists;
   - the Model H's own GPS chip works once the firmware knows the board type (15), which all our builds now read at boot (the A0 voltage change): `GNSS:OK(I)`, a fix on the desk with 4–12 satellites, latitude/longitude in all 20 uploads checked, in `bench-beam` and `bench-beam-obd`;
   - so `CONFIG_GNSS=GNSS_STANDALONE` again. Earlier `GNSS:NO` came from OBD-off builds that didn't read the board type;
   - seen once: after this boot the accelerometer read `0.08;0.04;-0.08` at rest (start-up calibration slightly off), so on the desk with USB power VS-lab may show "running" by vibration. In a car RPM or voltage decide.
6. **Car test 1, `bench-beam-obd`.** Engine running, sky view, 3–5 min. Check:
   - GPS position appears in VS-lab and follows the drive;
   - engine on/off follows RPM;
   - voltage running vs. off;
   - no repeating beep;
   - unplug and replug recovery.
7. **Car test 2, `bench-beam` with A0 voltage.** Multimeter comparison skipped (Craig, 2026-10-25: no meter, readings look believable; revisit if engine on/off by voltage misbehaves). Engine on/off from voltage only. Compare against a multimeter, engine off and running; thresholds are 13.2 V running and ≤12.6 V off. Add a calibration factor if the reading is consistently off.
8. **Merge `feat/cell-beam`** after the car tests.
9. **Send the SIMCom bug report** (`docs/simcom-sni-report.md`).
10. ✅ **Fix the invalid Anthropic API key** (fixed 2026-10-25: Craig saved a new key at 01:08 UTC and redeployed; his scan worked and no scan errors since) for scan-to-fill: `POST /machines/new` returned 401 "Invalid bearer token" on 2026-10-24.
    - Checked 2026-10-25 (Vercel runtime errors and env list; key value not read): one failure, 2026-10-24 19:42 UTC. `ANTHROPIC_API_KEY` exists for Production and Preview, set the same day (~11:33 UTC), never changed.
    - The SDK in use (`@anthropic-ai/sdk` 1.x) sends the API key as `Authorization: Bearer <key>`, so "Invalid bearer token" means the key itself is rejected (mistyped, extra characters, or revoked), not a missing variable.
    - ⏳ Craig: create a new key in the Claude Console (API keys), paste it into Vercel → Settings → Environment Variables → `ANTHROPIC_API_KEY` (Production and Preview, no quotes or spaces), redeploy, then try a scan.
11. ✅ **Small clean-ups**, 2026-10-25:
    - tamper watchdog: a reading under the 8 V floor is now "Was not on machine power", with no change to the concern (`fix/battery-floor`, `8a14d5c`, tested);
    - fork change markers: all 18 now start with `VSLAB` (`// VSLAB:`, `// VSLAB test build:`, `// VSLAB test mode:`), noted in `firmware/README.md` (`feat/cell-beam`, `11360c8`).
- **Drive test 2026-10-25 evening (CX-9, DEMO, `bench-beam-obd`):** engine off at 18:36 NDT (21:06 UTC). No runtime errors.
  Engine showed Off "since 18:39" (Craig): the last uploads that arrived were from 18:32 (`gpsTime` 21021040, 35 km/h,
  `obdRpm` 1131); 18:32–18:36 never arrived (−83 dBm), and the device signed off at ~18:40. A 4–5 min dead zone
  earlier was drawn as a straight line (now dashed, "no data"). OBD RPM confirmed working. Since then VS-lab times
  engine starts/stops from reading times. Remaining fixes are firmware: see "Firmware to-do" above.
12. **On hold: location history / store-and-forward.**
    - PSRAM: present (8 MB) and enabled in our builds ✅. Investigate `CONFIG_STORAGE` and the SD card.
    - Plan written: [store-and-forward.md](store-and-forward.md) (2026-10-25). Recommended order: VS-lab uses the device's GPS time; then the device keeps failed readings, sends oldest first, doesn't wipe on sleep and sends in batches every 10–15 s (about 3–4 h in memory); then replay from the memory card to survive power cuts.
    - ✅ Step 1 done 2026-10-25 (on `main`): `telemetry.recorded_at` from GPS time / uptime; found when the parked car's map fanned out to the earlier route.

---

## How to check the device without a laptop

- **Soracom console → SIM:** "Online" means registered with a data session. Data usage shows traffic, but lags about 15 minutes.
- **VS-lab → Devices / Fleet:** "Last report" every few seconds means uploads are working.
- **Vercel runtime logs** show only requests that log or fail. A successful device upload leaves no line there, so don't use them to confirm a connection.
