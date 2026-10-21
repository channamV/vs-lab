# Firmware

## Today: stock firmware

The device runs Freematics' open-source **Telelogger** firmware, unmodified, configured to report
to our platform. Setup steps: [docs/freematics-setup.md](../docs/freematics-setup.md).

- Source: github.com/stanleyhuangyc/Freematics, `firmware_v5/telelogger`
- Device library (modem, GPS, OBD, buzzer): `libraries/FreematicsPlus`
- Build system: PlatformIO (`platformio.ini` is included upstream), Arduino framework on ESP32
- Our device: ONE+ Model H, SIM7670 modem (supported by `FreematicsPlus`; auto-detected)

## Next: our own fork

When Tier 2 needs device changes (see [product tiers](../docs/product-tiers.md)), we'll copy
Telelogger into `firmware/telelogger/`, keep the upstream version noted, and change it in small,
tested steps:

1. Enable SNI for HTTPS on the SIM7670 (if cellular uploads fail against Vercel)
2. Read commands from the server's reply to each upload (buzzer on/off, report interval)
3. BLE beacon scanning, adding nearby beacon IDs to each report
4. Over-the-air firmware updates
5. Device authentication
6. Read J1939 (heavy equipment) and send the fields listed in [docs/can-data.md](../docs/can-data.md) (the
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
