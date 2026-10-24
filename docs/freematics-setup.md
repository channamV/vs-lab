# Freematics ONE+ Model H setup

Goal: a new device reports to **our platform** (`vs-lab-platform-tpj9.vercel.app`) over Soracom cellular, and its
data shows on a machine's page. For now cellular goes through Soracom Beam (lab only): the modem can't reach Vercel
over HTTPS itself. See [Cellular via Soracom Beam](#cellular-via-soracom-beam-lab).

The device runs **our build of Freematics Telelogger** (`firmware/telelogger`). It's the stock firmware with the
settings already filled in, plus our fixes (see [firmware/README.md](../firmware/README.md)). Freematics Builder can't
apply those, so we flash from your PC with PlatformIO; Claude Code on your PC does it for you.

## What you need

- Freematics ONE+ **Model H** (SIM7670 LTE Cat 1)
- **Soracom plan01s** SIM (APN `soracom.io`)
- **microSD card** (optional, 4–32 GB, FAT32). The device also writes its data to the card, a backup while
  there's no signal.
- The device's **USB cable** (a data cable, not charge-only)
- For cellular tests on the bench: a **12 V OBD-II bench power supply**, or test in a vehicle. Over USB alone the
  modem can brown out when it transmits (on our bench unit USB was enough, 2026-10-24).
- For cellular: the SIM in a Soracom group with **Beam** set up ([see below](#cellular-via-soracom-beam-lab))
- Your Windows PC with **Claude Code** and **git**, and the vs-lab repository cloned

## 1. Get the SIM ready (Soracom console)

1. Sign in at **console.soracom.io** → **SIM Management**.
2. Find the SIM by its **ICCID** (printed on the card, e.g. `89423 10223 00256 471 2`).
   - Listed with status **Ready** or **Active**: good.
   - Not listed: **Register SIM** and enter the numbers the console asks for (they're on the card).
3. Give it a **Name** you'll recognise later, e.g. `VS Lab #1`. Add the device ID once you know it (step 4).
4. Keep the card: the **PUK** on it unlocks the SIM if it ever gets PIN-locked.

## 2. Put the SIM and microSD card in

**Unplug the device first.** Cards go in and out with the power off.

1. **SIM size: micro SIM.** The Soracom card is a three-size "triple cut". Press out the **middle (micro)** size: the
   outline around the gold chip that also takes in the "SG002" print. Don't press the tiny nano piece out of it.
   Compare it with the slot before forcing anything. If it's loose or wrong, stop and check the device's manual.
2. Insert the SIM into the SIM slot, chip side and notched corner as marked on the case.
3. **microSD card**: it should already be FAT32. Most new cards up to 32 GB are. If Windows says otherwise,
   right-click it in File Explorer → Format → FAT32. Insert it into the microSD slot.
4. If your unit has antenna connectors, fit the antennas **before** powering on.

## 3. Flash our firmware (Claude Code on your PC)

Plug the device into the PC by USB. Then open Claude Code **in your vs-lab folder** and paste:

> Pull the latest vs-lab from GitHub. My Freematics ONE+ Model H is plugged in by USB. Install PlatformIO if needed, find
> its COM port, then build and flash `firmware/telelogger` with the `bench` environment
> (`pio run -e bench -t upload` from that folder). Then open the serial monitor at 115200 baud, watch the log for
> 3 minutes and tell me the DEVICE ID and whether uploads to the server get OK replies. Follow docs/freematics-setup.md.

Claude installs the tools, checks for the USB driver, builds (the first build downloads the ESP32 toolchain, several
minutes), flashes and reads the log.

Which build:

| Build | When |
|---|---|
| `bench` | On the desk (OBD off, so it doesn't wait for a vehicle) |
| `vehicle` | Plugged into a truck's or machine's OBD/diagnostic port (OBD data on) |
| `bench-nobt` | Early Wi-Fi tests only, if the device runs short of memory: Bluetooth off. Real deployments need Bluetooth (beacons and the phone app authorise operators), so don't use it beyond the bench |
| `bench-beam` | Cellular tests for now, on the desk or in a car (lab only): uploads go through Soracom Beam ([see below](#cellular-via-soracom-beam-lab)). Bluetooth on, OBD off, no Wi-Fi |

**Optional Wi-Fi** (handy if cellular gives trouble): tell Claude your Wi-Fi name and password and to set
`VSLAB_WIFI_SSID` / `VSLAB_WIFI_PASSWORD` for the build. They're never saved in the repository. The device then uses
Wi-Fi when it's in range and cellular otherwise. Only 2.4 GHz networks work. For now Wi-Fi uploads need the
`bench-nobt` build: with Bluetooth on, the ESP32 runs out of memory for the secure connection (see
[firmware/README.md](../firmware/README.md), "Bluetooth must stay").

## 4. What a healthy log looks like

Roughly, in order:

```
DEVICE ID:XXXXXXXX                          ← write this down (Soracom name, label on the device)
[CELL] Activating...
CELL:SIM7670...                             ← modem found
IMEI:...
APN:soracom.io
Operator:...                                ← registered on a network (Soracom roams on local carriers)
CELL GNSS:OK                                ← GPS on the modem switched on (not yet: see firmware/README.md)
[CELL] IP:...                               ← data connection up
LOGIN(beam.soracom.io:80)...                ← bench-beam; other builds show vs-lab-platform-tpj9.vercel.app:443
[CELL] In service
[HTTP] OK 1                                 ← our platform accepted the data (repeats every second or so)
```

## 5. On the platform

1. **Platform** (Veristart staff menu): the device appears in **Veristart stock** under its DEVICE ID as soon as it
   reports. Click it for diagnostics: last report, battery, signal, position.
2. Add a test machine: **Fleet → Add machine** (e.g. "Bench unit", type Pickup / light vehicle).
3. **Pair** the device with that machine (Platform page, or the machine's *Tracking device* box).
4. The machine's page now shows position, engine on/off and the rest. The simulator's demo machines are
   unaffected.

## 6. In a vehicle

Re-flash with the `vehicle` build, plug the device into the OBD-II port, start the engine and drive. Engine
start/stop, speed and trips should appear on the machine's page. Heavy equipment often has a 9-pin Deutsch (J1939)
port instead: that needs an adapter cable, and J1939 data needs our later firmware work ([can-data.md](can-data.md)).
There's no `vehicle` build through Beam yet: for a cellular test in a car, use `bench-beam` (uploads and signal, but
no OBD data).

## Cellular via Soracom Beam (lab)

The device sends **plain HTTP to Soracom Beam** (`beam.soracom.io`, port 80) and Soracom forwards it **over HTTPS,
with SNI**, to our platform. It's a lab workaround: it only works with Soracom SIMs, Soracom charges a small fee per
request, and the hop from the device to Soracom isn't encrypted by the device (it stays inside the cellular network).
Long term the device will do HTTPS itself, on the ESP32.

**Soracom console, once** (console.soracom.io):
1. Put the SIM in a SIM group, e.g. `vs-lab-beam` (SIM Management → select the SIM → change group).
2. In that group, SORACOM Beam → add a **Website entry point** that forwards to HTTPS, host
   `vs-lab-platform-tpj9.vercel.app`, port 443.

**Firmware:** the `bench-beam` build (`pio run -e bench-beam -t upload`): Bluetooth on, modem GPS, OBD off, server
`beam.soracom.io` port 80. **No Wi-Fi**: the firmware uses one server for Wi-Fi and cellular, and Beam only answers
Soracom SIMs. Healthy log: `LOGIN(beam.soracom.io:80)...` then `[HTTP] OK 1` for every upload.

### HTTPS over the SIM7670 modem doesn't work

Found 2026-10-24 on device `Y5725A32`: modem **SIM7670G-LNGV, firmware `2368B01SIM767XM5A`** (build
`SIM767XM5_B01V03_240309`).
- Vercel serves many sites from the same addresses, so a device has to name the site when it opens a secure connection
  ("SNI"). Without it, Vercel answers **`421 Misdirected Request`** (with the header `X-Vercel-Mitigated: deny`).
- The modem **accepts the SNI setting but never applies it**. `AT+CSSLCFG="enableSNI",0,1` answers OK, and reading
  the settings back (`AT+CSSLCFG=0`) shows it on, yet every request gets the 421. That's true through the modem's HTTP
  client (`AT+HTTP…`: URL with and without `:443`, SSL context 0 or 1, HTTP service restarted) and through its
  secure-socket commands (`AT+CCH…`).
- **The proof** (certificate test): with certificate checking on (`authmode` 1), the modem only completes the
  connection when it trusts the root of Vercel's **no-SNI** certificate (`no-sni.vercel-infra.com`, Let's Encrypt
  ISRG Root X1), never the root of the real one (`*.vercel.app`, Google GTS Root R1). So Vercel saw no server name.
- Ways out: a newer modem firmware (ask SIMCom or the distributor), or HTTPS on the ESP32 over a plain modem
  connection (later). Until then, Beam.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No COM port appears | Charge-only cable, or the USB driver (CH340 / CP210x) is missing. Claude can install it |
| Upload fails "port busy" | The serial monitor is open: close it, then upload |
| Modem not found / keeps restarting when it transmits | Not enough power over USB: use the 12 V supply or a vehicle |
| No network / `CELL` errors | SIM not Ready/Active in Soracom, SIM not seated, wrong size, or no coverage indoors |
| `421 Misdirected Request` over cellular (every upload) | The modem doesn't send the server name (SNI), so Vercel refuses the request ([details](#https-over-the-sim7670-modem-doesnt-work)): use the `bench-beam` build |
| With `bench-beam`: replies `404` or `5xx` | The Beam settings are wrong: check the Website entry point (HTTPS, host `vs-lab-platform-tpj9.vercel.app`, port 443) |
| With `bench-beam`: no reply, or modem errors `7xx` | The device isn't reaching Beam: the SIM isn't in the Beam group, or it isn't a Soracom SIM |
| Registered, but every upload fails (anything else) | Check the log for errors and tell Claude |
| `[CELL] Searching...` then `[CELL] Deactivated` within seconds | The firmware gives up when the modem answers with its start-up messages (an upstream quirk) and tries again 3 minutes later. A test build with `VSLAB_CELL_DEBUG` logs the modem's replies and keeps waiting |
| Reports arrive, no position | Indoors: put it by a window or outside for the first GPS fix |
| Data arrives but nothing on the Fleet page | Not paired yet (step 5) |
| Old settings seem to stick (wrong APN/Wi-Fi) | Settings saved by an earlier firmware override ours: ask Claude to erase the flash (`pio run -t erase`) and flash again |
| Build fails with `CreateProcess: No such file or directory` | The compile command is longer than Windows allows (32,767 characters). Happens when another PlatformIO project installed a different espressif32 version first, so ours lands in folders with long versioned names (`framework-arduinoespressif32@3.20017…`). Build with a separate, short PlatformIO folder: PowerShell `$env:PLATFORMIO_CORE_DIR="$env:USERPROFILE\.pio"` before `pio run` (the first build downloads the toolchain again) |
| Build fails with `missing terminating " character` after setting Wi-Fi | The Wi-Fi name contains a space: PlatformIO splits build flags at spaces (and turns `\` into `/`, so escaping doesn't help). Leave `VSLAB_WIFI_SSID` empty and pass the name in a small header outside the repository instead: a file `wifi_ssid.h` containing `#undef CONFIG_WIFI_SSID` and `#define CONFIG_WIFI_SSID "My Wifi"`, then `$env:PLATFORMIO_BUILD_FLAGS="-include C:/path/to/wifi_ssid.h"` (forward slashes, a path without spaces). Claude does this for you |
| Wi-Fi joins but every upload fails with `SSL - Memory allocation failed`, then the device reboots | Bluetooth uses the memory the secure connection needs: use the `bench-nobt` build for Wi-Fi tests |

## Security notes (before real customer use)

- Devices are identified only by their ID in the URL; anyone who knows an ID could send fake data. Set
  `DEVICE_AUTO_REGISTER=false` once devices are registered; device authentication comes later.
- The firmware doesn't check the server's certificate yet. OK for a lab, not for production.
- `bench-beam` sends plain HTTP from the device to Soracom; only the Soracom → Vercel hop is HTTPS. Lab only, not for
  customer devices.
- Bluetooth is on (Freematics Controller app). Its commands have no password and can read back the Wi-Fi password.
  Fine on the bench; to be locked down in our firmware work.
