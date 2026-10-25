# Hardware bring-up log (Freematics Model H, Y5725A32)

The working record for the device phase: what's proven, what's decided, what's open.

**Who updates it:** whichever Claude session does device work updates it at the end of each step, so the next session has the full context. Updates are committed to `main` (docs only), so every session reads one copy; the work itself stays on its branch until merged.

**Last updated:** 2026-10-25

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

**Build on the device now:** `bench-beam-obd`. **Kept for the first car test:** the CX-9 has an ECU, so OBD connects once and the retry cost doesn't apply.

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

1. **Keep and resend readings (store-and-forward step 2, [store-and-forward.md](store-and-forward.md)).**
   - Keep a batch whose send failed (don't purge it); send oldest first; don't wipe the buffer on standby
     (`bufman.purge()` in the standby loop) — send what's left before signing off, or on the next wake.
   - Send in batches every 10–15 s while running (several samples per POST), which also cuts Soracom requests.
   - Tell VS-lab (the cloud session) before shipping resends: VS-lab should then ignore duplicates by device + reading
     time (a resent batch whose reply was lost). Not built yet; small.
2. **Final "engine off" reading before sleeping.** In `process()`, when OBD fails (`[OBD] ECU OFF`) the in-progress
   buffer is dropped (`return` with the buffer still FILLING) and standby purges the rest. Instead: add a last sample
   with `obdRpm` 0 (PID 0x10C) plus GPS and voltage, send it (with anything still buffered), then sign off. Same for the
   stationary timeout. VS-lab then records the stop at the last running reading with an explicit "off" right after.
3. **Send the GPS date** (PID 0x11, `gd->date`) with the GPS time, so VS-lab doesn't have to infer the date (it assumes
   readings are under 6 hours old). Small.
4. **Unplug/replug recovery** (left from car test 1): unplug while running, plug back in; check it reconnects on its
   own and VS-lab raises the tamper "power interrupted" incident.
5. Then **merge `feat/cell-beam`** (item 8) and send the SIMCom report (item 9).

Rules as before: mark changes `// VSLAB:`, keep Bluetooth on in deployment builds, build/flash on Craig's PC, update this
file after each step.

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
