# Hardware bring-up log (Freematics Model H, Y5725A32)

The working record for the device phase: what's proven, what's decided, what's open.

**Who updates it:** whichever Claude session does device work updates it at the end of each step, so the next session has the full context.

**Last updated:** 2026-10-25

---

## Status at a glance

| Area | Status |
|---|---|
| Wi-Fi upload to VS-lab | ✅ Works (`bench-nobt`; TLS on the ESP32 runs out of memory with Bluetooth on) |
| Cellular registration on 12 V | ✅ Works. On USB the modem used to reboot during network search; it held on USB on 2026-10-24 but don't rely on it |
| Cellular HTTPS direct to Vercel | ❌ Impossible on this modem firmware (no SNI → Vercel `421`), see below |
| Cellular via **Soracom Beam** | ✅ Works. Y5725A32 reports to VS-lab every few seconds (`feat/cell-beam`) |
| Modem GPS (`GNSS_CELLULAR`) | ⏳ Untested. No fix yet (device was indoors) |
| Engine on/off from OBD RPM | ⏳ Car test pending (`bench-beam-obd`) |
| Engine on/off from supply voltage, no OBD | ⏳ A0 voltage in OBD-off builds proposed (see open items) |
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
- **Supply voltage (PID 0x24):** only sent when `ENABLE_OBD`. On board type 15 (Model H) it's `analogRead(A0)*45/4095`, with no co-processor involved.
- **Cost of OBD with no ECU:** the build retries `obd.init` every cycle, about 2.9 s each. Start-up takes +10 s, and moving-interval sampling drops from 1 s to about 3–4 s. So OBD stays off in `bench-beam`.
- **USB reads 3.61–3.69 V:** treat readings below a 6–8 V floor as "not on machine power".
- **Production data to clean up:** false CX-9 engine sessions from the 2026-10-24 desk run. Delete only after Craig reviews the exact rows.

### 5. Telelogger buffering (stock source)

- **RAM ring buffer:** 32×256 B, or 1024×384 B with PSRAM. That's about 0.5–2.5 min of backlog, or about 15–85 min with PSRAM. Oldest slots are overwritten.
- **Upload order:** newest first (`getNewest`).
- **Data that's dropped:**
  - a failed send is purged, not put back in the buffer;
  - the whole buffer is purged on standby and on high temperature.
- **SD card logging is write-only:** nothing replays from it.
- **PSRAM is off in the stock `platformio.ini`.** ⏳ Check the boot log for `PSRAM:`.
- **VS-lab timestamps:** VS-lab stamps samples with **arrival time** (`receivedAt`). It parses `gpsTime`/`gpsDate` but doesn't use them. Any backlog lands at the wrong time.

---

## Decisions

| Date | Decision |
|---|---|
| 2026-10-24 | Bluetooth is required in deployment. `bench-nobt` is only for early Wi-Fi tests |
| 2026-10-24 | Soracom Beam for cellular in the lab. ESP32-side TLS is the production direction |
| 2026-10-25 | `bench-beam` keeps OBD off (retry cost). `bench-beam-obd` is for vehicles with an ECU |
| 2026-10-25 | **Location history with store-and-forward is a core requirement.** Current location alone is not a success. Work is on hold for now; raise it again for ESP32 TLS, custom PCB storage choice and pilot readiness |

---

## Open items (in order)

1. **Merge `fix/engine-vibration`** (`be90819`). Confirm migration `0031_engine_unknown_since` runs on the Vercel deploy.
2. **Clean up the false CX-9 engine sessions.** List the rows for Craig, delete only after approval, then recalculate the engine state.
3. **A0 voltage in OBD-off builds** (`feat/cell-beam`):
   - when `ENABLE_OBD` is 0 and the board type is greater than 12, send 0x24 from `analogRead(A0)*45/4095`, in centivolts;
   - mark it `// VSLAB:`;
   - rebuild `bench-beam` and check on the desk: 0x24 in every upload, timing unchanged, engine "off".
4. **`fix/battery-floor`** (VS-lab):
   - below about 6–8 V means "not on machine power";
   - it applies to battery alerts (`battery.ts`) and to the voltage check in `detectEngine`;
   - test with the real 361–369 cV values.
5. **Car test 1, `bench-beam-obd`.** Engine running, sky view, 3–5 min. Check:
   - GPS fix appears in VS-lab;
   - engine on/off follows RPM;
   - voltage running vs. off;
   - no repeating beep;
   - unplug and replug recovery.
6. **Car test 2, `bench-beam` with A0 voltage.** Engine on/off from voltage only. Compare against a multimeter, engine off and running; thresholds are 13.2 V running and ≤12.6 V off. Add a calibration factor if the reading is consistently off.
7. **Merge `feat/cell-beam`** after the car tests.
8. **Send the SIMCom bug report** (`docs/simcom-sni-report.md`).
9. **Fix the invalid Anthropic API key** for scan-to-fill: `POST /machines/new` returned 401 "Invalid bearer token" on 2026-10-24.
10. **On hold: location history / store-and-forward.**
    - Investigate PSRAM, `CONFIG_STORAGE` and the SD card.
    - Enable PSRAM if the board has it.
    - Write `docs/store-and-forward.md`. Device side: persist with GPS time, send oldest first in batches, advance only on HTTP 200, survive reboot, no purge on standby. Server side: GPS-time timestamps, out-of-order and duplicate handling.
    - Small first step: `feat/gps-timestamps`, storing the device GPS time on each telemetry row.

---

## How to check the device without a laptop

- **Soracom console → SIM:** "Online" means registered with a data session. Data usage shows traffic, but lags about 15 minutes.
- **VS-lab → Devices / Fleet:** "Last report" every few seconds means uploads are working.
- **Vercel runtime logs** show only requests that log or fail. A successful device upload leaves no line there, so don't use them to confirm a connection.
