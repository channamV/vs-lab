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
| Modem GPS (`GNSS_CELLULAR`) | ❌ Never switched on: the library uses SIM7600 GPS commands (`AT+CGPS`), which the SIM7670G rejects, so `CELL GNSS:OK` never appears. Needs the SIM7670G's own commands (open item 5) before any fix can show |
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
- **Old bug, fixed on `fix/engine-vibration`:** the check was `|g − 1| ≥ 0.05`, so a still device read as running. Now it's `hypot(accel) ≥ 0.05`, plus a new "Unknown" status.
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
- **VS-lab timestamps:** VS-lab stamps samples with **arrival time** (`receivedAt`). It parses `gpsTime`/`gpsDate` but doesn't use them. Any backlog lands at the wrong time.

---

## Decisions

| Date | Decision |
|---|---|
| 2026-10-24 | Bluetooth is required in deployment. `bench-nobt` is only for early Wi-Fi tests |
| 2026-10-24 | Soracom Beam for cellular in the lab. ESP32-side TLS is the production direction |
| 2026-10-25 | `bench-beam` keeps OBD off (retry cost). `bench-beam-obd` is for vehicles with an ECU |
| 2026-10-25 | **Location history with store-and-forward is a core requirement.** Current location alone is not a success. Work is on hold for now; raise it again for ESP32 TLS, custom PCB storage choice and pilot readiness |
| 2026-10-25 | A0 supply voltage only on board type 15, the only type checked (upstream uses A0 for every type above 12). OBD-off builds start the co-processor link at boot just to read the board type |
| 2026-10-25 | Supply floor 8 V. USB reads about 3.6 V and never more than about 5 V; a 12 V system the device runs on reads 10.5 V or more even when flat, and rarely under 9.5 V while cranking; below 8 V the machine couldn't start anyway |

---

## Open items (in order)

1. **Merge `fix/engine-vibration`** (`be90819`). Confirm migration `0031_engine_unknown_since` runs on the Vercel deploy. ⏳ Waiting for Craig's go-ahead (production deploy with a migration). Merge it before `fix/battery-floor`.
2. **Clean up the false CX-9 engine sessions.** List the rows for Craig, delete only after approval, then recalculate the engine state.
3. ✅ **A0 voltage in OBD-off builds** (`feat/cell-beam`, `a742e40` code, `84f5484` docs), 2026-10-25:
   - OBD-off builds send 0x24 from `analogRead(A0)*45/4095` in centivolts, on board type 15 only (see Decisions); marked `// VSLAB:`;
   - desk check with `bench-beam`: 0x24 in every upload and timing unchanged (Findings 4);
   - engine "off" in VS-lab: ⏳ Craig to confirm on the Fleet page (live `main` reads 3.5–3.7 V as off by voltage).
4. ✅ **`fix/battery-floor`** (VS-lab, `940d40f`), 2026-10-25:
   - floor 8 V (see Decisions), one constant (`ENGINE_THRESHOLDS.machinePowerMinVolts`) used by `detectEngine` and `battery.ts`;
   - tests with the real 361/365/369 cV values and the 7.99 / 8.00 V boundary; `npm run check` passes (267 tests);
   - merge after `fix/engine-vibration`: on its own, desk readings would fall through to the old vibration rule (running). A trial merge of the two is clean.
5. **Modem GPS on the SIM7670G.** Switch it on with the SIM7670G's commands (`AT+CGNSSPWR=1`, wait for `+CGNSSPWR: READY!`) and read `AT+CGNSSINFO` into the GPS fields, instead of the SIM7600 ones (`AT+CGPS`). Try the commands by hand first with the pass-through build. Without this, car test 1 can't show a fix.
6. **Car test 1, `bench-beam-obd`.** Engine running, sky view, 3–5 min. Check:
   - GPS fix appears in VS-lab (only after item 5);
   - engine on/off follows RPM;
   - voltage running vs. off;
   - no repeating beep;
   - unplug and replug recovery.
7. **Car test 2, `bench-beam` with A0 voltage.** Engine on/off from voltage only. Compare against a multimeter, engine off and running; thresholds are 13.2 V running and ≤12.6 V off. Add a calibration factor if the reading is consistently off.
8. **Merge `feat/cell-beam`** after the car tests.
9. **Send the SIMCom bug report** (`docs/simcom-sni-report.md`).
10. **Fix the invalid Anthropic API key** for scan-to-fill: `POST /machines/new` returned 401 "Invalid bearer token" on 2026-10-24.
11. **Small clean-ups:**
    - the tamper watchdog (`tamper.ts:117`) explains a quiet device with a reading under the floor as "Battery was low (3.6 V): may have run flat"; apply the 8 V floor there too;
    - fork change markers: the earlier changes use `// VS Lab:`, the A0 change `// VSLAB:`; pick one so a search finds them all.
12. **On hold: location history / store-and-forward.**
    - PSRAM: present (8 MB) and enabled in our builds ✅. Investigate `CONFIG_STORAGE` and the SD card.
    - Write `docs/store-and-forward.md`. Device side: persist with GPS time, send oldest first in batches, advance only on HTTP 200, survive reboot, no purge on standby. Server side: GPS-time timestamps, out-of-order and duplicate handling.
    - Small first step: `feat/gps-timestamps`, storing the device GPS time on each telemetry row.

---

## How to check the device without a laptop

- **Soracom console → SIM:** "Online" means registered with a data session. Data usage shows traffic, but lags about 15 minutes.
- **VS-lab → Devices / Fleet:** "Last report" every few seconds means uploads are working.
- **Vercel runtime logs** show only requests that log or fail. A successful device upload leaves no line there, so don't use them to confirm a connection.
