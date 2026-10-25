# Firmware

## Today: our build of Telelogger

`firmware/telelogger` is Freematics' open-source **Telelogger** firmware, and `firmware/libraries` the libraries it
needs, copied from github.com/stanleyhuangyc/Freematics at commit `9b0a68d8` (2025-12-16): `firmware_v5/telelogger`,
`libraries/FreematicsPlus`, `FreematicsOLED`, `httpd`, `TinyGPS`. The first commit adding them is the untouched
upstream copy, so `git diff 51160f1 -- firmware/` shows everything we've changed. Each change in the code is also marked
with a `VSLAB` comment (`// VSLAB:`, or `// VSLAB test build:` / `// VSLAB test mode:` for code that's off in normal
builds), so searching for `VSLAB` finds them all.

Our changes so far:

| Change | Where |
|---|---|
| Settings for our platform: server `vs-lab-platform-tpj9.vercel.app:443`, HTTPS POST, Soracom APN, microSD storage, PSRAM, Wi-Fi from environment variables (never in the repo); `bench` (OBD off) and `vehicle` builds; platform pinned to espressif32 6.x (Arduino-ESP32 2.x, which this code needs) | `telelogger/platformio.ini` (config.h unchanged) |
| **SNI setting for HTTPS over the SIM7670 modem** (`AT+CSSLCFG="enableSNI",0,1`). Kept, but it doesn't work: the modem's firmware (`2368B01SIM767XM5A`) accepts the setting and never sends SNI, so Vercel answers every HTTPS request from the modem with `421 Misdirected Request` (proof in [the setup guide](../docs/freematics-setup.md#https-over-the-sim7670-modem-doesnt-work)) | `libraries/FreematicsPlus/FreematicsNetwork.cpp`, `CellHTTP::init` |
| **HTTPS over Wi-Fi.** Upstream sent plain HTTP over Wi-Fi even to port 443, and Vercel answered every upload with a redirect to HTTPS. Now TLS on port 443 (server certificate not checked yet, as on cellular). Also: reconnect when the server closed the connection, end the old TLS session before reconnecting (it leaked memory), and don't crash in the cellular fallback when the modem was never started. TLS over Wi-Fi only fits in the ESP32's internal RAM with Bluetooth off (the `bench-nobt` build); with it on, the first connection fails (`SSL - Memory allocation failed`). Confirmed on the device 2026-10-24: every upload answered OK | `libraries/FreematicsPlus/FreematicsNetwork.cpp/.h`, `WifiHTTP`, `CellSIMCOM::sendCommand`, `CellHTTP::open` |
| **GPS: the board's own chip** (`CONFIG_GNSS=GNSS_STANDALONE`). The SIM7670G-LNGV modem has no GPS: it answers ERROR to every GNSS command (`AT+CGNSSPWR`, `AT+CGPS`, …; only `AT+CLBS` cell-tower location exists). The Model H's own GPS chip works once the firmware knows the board type (15): boot log `GNSS:OK(I)`, a fix indoors with 4–12 satellites, position in every upload (2026-10-25). Earlier `GNSS:NO` came from OBD-off builds that didn't read the board type | `telelogger/platformio.ini` |
| **Cellular through Soracom Beam** (`bench-beam` build, lab only): the device sends plain HTTP to `beam.soracom.io` (port 80) and Soracom forwards it over HTTPS, with SNI, to our platform. The modem's HTTP client now uses `http://` unless the port is 443 (upstream always used `https://`), sets the SSL context only for 443, and restarts its HTTP service (`AT+HTTPTERM`) before `AT+HTTPINIT`: one left running across an ESP32 restart made `HTTPINIT` answer ERROR. Confirmed on the device 2026-10-24 with Bluetooth on: every upload answered `OK` | `telelogger/platformio.ini`, `libraries/FreematicsPlus/FreematicsNetwork.cpp`, `CellHTTP::open`/`send` |
| **Supply voltage (PID 0x24) without OBD.** The Model H is board type 15 (`TYPE:15`), which reads its supply voltage on the ESP32's A0 pin (`analogRead(A0) * 45 / 4095`). Upstream only sends it from OBD builds; ours also sends it from OBD-off builds on board type 15, which start the co-processor link at boot only to learn the board type. Desk test 2026-10-24 with `bench-beam` (USB power): 0x24 in all 59 uploads (3.51–3.69 V), sample timing unchanged (1 / 2 / 5 s), first sample ~2 s later (5.9 s after boot). `bench-beam-obd` (OBD on) sends it too, but with no engine computer answering it retries every cycle: first sample at 14.5 s, samples every 2.9 s instead of 1–2 s | `telelogger/telelogger.ino`, `telelogger/platformio.ini` (`[beam]`, `bench-beam-obd`) |
| **Store-and-forward** (step 2 of [store-and-forward.md](../docs/store-and-forward.md)). Readings stay in the buffer until the server answers 200 (upstream discarded each one before knowing whether it was sent); a 4xx reply drops them, since a retry can't help. They go out oldest first, up to 15 per upload, once the oldest has waited 15 s (`VSLAB_BATCH_SECONDS`), so about one upload every 15–20 s instead of one per reading. After a failure: 5 s pause before retrying. Before signing off for sleep it sends what's left (the device restarts on wake, clearing memory). Desk test 2026-10-25 with a pretend 80 s dead zone (`VSLAB_TEST_OUTAGE`): 45 readings recorded, 45 delivered, the backlog in two uploads right after | `telelogger/telelogger.ino` (`sendBatch`), `telelogger/teleclient.cpp/.h`, `libraries/FreematicsPlus/FreematicsNetwork.cpp` |
| **Test-only switches**, off in every normal build: `VSLAB_CELL_DEBUG` (logs the modem's replies during the network search and its SSL setup, waits 3 minutes for the network, no standby on the desk, tries the SNI experiments) and `VSLAB_MODEM_PASSTHROUGH` (the ESP32 only relays USB ↔ modem, for typing AT commands by hand). Turn on with `$env:PLATFORMIO_BUILD_FLAGS="-DVSLAB_CELL_DEBUG"` | `libraries/FreematicsPlus/FreematicsNetwork.cpp`, `telelogger/telelogger.ino` |

Status (2026-10-24, device `Y5725A32`, on USB power): Wi-Fi uploads work with `bench-nobt`. Cellular works through
Soracom Beam with `bench-beam`, Bluetooth on: every upload answered `OK`. Direct HTTPS over the modem
doesn't (the modem never sends SNI). Car test with `bench-beam` still to do; modem GPS not working yet. PlatformIO's
servers are blocked in Claude's cloud sessions, so builds happen on Craig's PC. Setup and flashing: [docs/freematics-setup.md](../docs/freematics-setup.md).

- Device library (modem, GPS, OBD, buzzer): `libraries/FreematicsPlus`; the Model H's SIM7670 modem is auto-detected
- Build system: PlatformIO, Arduino framework on ESP32

## Bluetooth must stay (Craig, 2026-10-24)

Bluetooth may be switched off **only for early Wi-Fi bench tests** (`-DCONFIG_ENABLE_BLE=0`). Deployed devices need
it: operators will be authorised in the field by **BLE beacons** and a Bluetooth signal from our **mobile app**.
Never make Bluetooth-off the default build.

Why it was switched off: memory. Telelogger's Bluetooth uses Espressif's full Bluetooth stack ("Bluedroid", in
`libraries/FreematicsPlus/utility/ble_spp_server.c`; already BLE-only, classic Bluetooth memory released). Bluedroid
plus Wi-Fi plus a secure (TLS) connection made by the ESP32 itself is the tightest case for the ESP32's built-in
memory. PSRAM doesn't help much there: the radios and TLS need the chip's own memory.

What changes that:
- **Cellular doesn't need the ESP32 to do TLS**: through Soracom Beam the ESP32 sends plain HTTP and Soracom adds
  HTTPS. Bluetooth + cellular via Beam is confirmed to fit (2026-10-24). The modem's own TLS can't be used with
  Vercel (it never sends SNI), so the long-term, carrier-independent design is TLS on the ESP32 over a plain modem
  connection, which brings this memory question back.
- **Replace Bluedroid with NimBLE** (a much lighter Bluetooth stack, commonly about half the memory). We need our own
  Bluetooth code anyway for beacon scanning and talking to the phone app (step 3 below), so we write that on NimBLE.
- Log free memory (`ESP.getFreeHeap()`, `ESP.getMinFreeHeap()`) in bench builds so each change is measured, not guessed.

## Next: further firmware changes

Further changes, in small tested steps (see [product tiers](../docs/product-tiers.md)):

1. ~~Enable SNI for HTTPS on the SIM7670~~: tested 2026-10-24, the modem ignores it. Cellular goes through Soracom
   Beam for now (lab only). Long term: TLS on the ESP32 over a plain modem connection (carrier-independent; also
   where checking the server's certificate will live). Not started.
2. Read commands from the server's reply to each upload and check-in, check their signature, run them and answer
   (format in [docs/device-commands.md](../docs/device-commands.md); the server side and a simulated device are built)
3. Bluetooth on NimBLE (replacing Bluedroid, see above): BLE beacon scanning, adding nearby beacon IDs to each
   report, and the phone-app connection for operator authorisation
4. Over-the-air firmware updates: download in 16 KB range pieces, check the whole file's SHA-256, install into the spare slot, roll back if the new
   version doesn't reach the server, wait for engine off; report `FW=` on login
   ([docs/firmware-updates.md](../docs/firmware-updates.md); the platform side and a simulated device are built)
5. Device authentication
6. Add OBD-II fuel level (PID 2F) to the polled list (for the fuel theft alert), and read J1939 (heavy equipment) and send the fields listed in [docs/can-data.md](../docs/can-data.md) (the
   platform side is built and tested with the simulator)
7. Include the battery voltage in the 15-minute standby check-ins, so the low battery warning sees the
   battery while the machine is parked (stock firmware only reports it while awake)

Each change follows the same loop: Claude edits → builds → flashes over USB → reads the serial log → fixes.
This must run on your PC (Claude Code with the device plugged in), not in a cloud session.

## Future: jobsite Wi-Fi (Starlink etc.) as a second connection

*Idea from Craig, 2026-10-21. Not scheduled; notes kept for when we build it.*

Many remote jobsites now have satellite internet (Starlink, etc.) with Wi-Fi, sometimes mounted on a machine's
roof. The device should use that Wi-Fi when there's no cellular coverage, and cellular when there's no Wi-Fi,
with the Wi-Fi name and password sent to it **over cellular** (while it's still in coverage) or **over Bluetooth**
from a phone standing next to the machine (when it's already offline).

**What stock Telelogger already does** (checked in the source, `firmware_v5/telelogger`):
- Has Wi-Fi built in (`ENABLE_WIFI`, on by default). If a Wi-Fi name is stored, it tries Wi-Fi first and uses
  cellular when Wi-Fi isn't available, switching back as Wi-Fi comes and goes; the 15-minute standby check-in
  also tries Wi-Fi first.
- Stores **one** Wi-Fi name and password in its settings memory (`WIFI_SSID`, `WIFI_PWD`), kept across restarts.
- Can already be given them over **Bluetooth** with the commands `SSID=<name>` and `WPWD=<password>`.

**What we'd add:**
1. **Over cellular:** a "set Wi-Fi" command in the server's reply (fork step 2 above), reusing the same code as
   the Bluetooth commands. Needs device authentication and signed commands first (step 5): nobody else may
   be able to change where a device sends its data.
2. **From a phone:** a page or app that talks to the device over Bluetooth (Web Bluetooth works in Chrome on
   Android; iPhones need an app). Could live on the check-in page for supervisors. Must be locked down:
   stock Bluetooth commands need no password and `WPWD?` **reads the password back**, so we'd require a
   per-device pairing code and remove the read-back.
3. **Several networks:** a short list of known networks (e.g. home yard + each jobsite) instead of one,
   tried in order.
4. **Platform side:** jobsite Wi-Fi entries per organization (later per project/jobsite), pushed to every
   machine at that site; passwords stored encrypted and never shown back in full; the machine page shows
   which connection each report came over (Wi-Fi or cellular) and when credentials were last delivered.
5. **Tamper watchdog:** knowing a machine is on jobsite Wi-Fi changes what "went quiet" means (e.g. the
   Starlink was switched off overnight). Include the connection type in the scoring.

**Things to check on the bench:**
- The ESP32 only uses **2.4 GHz** Wi-Fi. Starlink routers usually offer 2.4 GHz, but some setups are 5 GHz only.
- Only ordinary password Wi-Fi works: no sign-in web pages (captive portals) and no company "enterprise" logins.
- Wi-Fi range from a roof-mounted dish to the device inside the cab; whether the device antenna needs moving.
- How fast it switches between Wi-Fi and cellular, and battery draw with both radios.
- Satellite internet adds delay but works fine for uploads; it doesn't let the server reach the device
  either, so cloud-to-device still relies on the reply-to-upload method (or an always-open connection).
