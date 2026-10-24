# Freematics ONE+ Model H setup

Goal: a new device reports to **our platform** (`vs-lab-platform-tpj9.vercel.app`) over Soracom cellular, and its
data shows on a machine's page.

The device runs **our build of Freematics Telelogger** (`firmware/telelogger`). It's the stock firmware with the
settings already filled in, plus one fix the SIM7670 modem needs to reach Vercel over cellular (see
[firmware/README.md](../firmware/README.md)). Freematics Builder can't apply that fix, so we flash from your PC with
PlatformIO; Claude Code on your PC does it for you.

## What you need

- Freematics ONE+ **Model H** (SIM7670 LTE Cat 1)
- **Soracom plan01s** SIM (APN `soracom.io`)
- **microSD card** (optional, 4–32 GB, FAT32). The device also writes its data to the card, a backup while
  there's no signal.
- The device's **USB cable** (a data cable, not charge-only)
- For cellular tests on the bench: a **12 V OBD-II bench power supply**, or test in a vehicle. Over USB alone the
  modem can brown out when it transmits.
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

**Optional Wi-Fi** (handy if cellular gives trouble): tell Claude your Wi-Fi name and password and to set
`VSLAB_WIFI_SSID` / `VSLAB_WIFI_PASSWORD` for the build. They're never saved in the repository. The device then uses
Wi-Fi when it's in range and cellular otherwise. Only 2.4 GHz networks work.

## 4. What a healthy log looks like

Roughly, in order:

```
DEVICE ID:XXXXXXXX                          ← write this down (Soracom name, label on the device)
GNSS:OK(I)                                  ← built-in GPS found
[CELL] Activating...
CELL:SIM7670...                             ← modem found
IMEI:...
APN:soracom.io
Operator:...                                ← registered on a network (Soracom roams on local carriers)
[CELL] IP:...                               ← data connection up
LOGIN(vs-lab-platform-tpj9.vercel.app:443)...
[HTTP] OK ...                               ← our platform accepted the data (repeats every few seconds)
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

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| No COM port appears | Charge-only cable, or the USB driver (CH340 / CP210x) is missing. Claude can install it |
| Upload fails "port busy" | The serial monitor is open: close it, then upload |
| Modem not found / keeps restarting when it transmits | Not enough power over USB: use the 12 V supply or a vehicle |
| No network / `CELL` errors | SIM not Ready/Active in Soracom, SIM not seated, wrong size, or no coverage indoors |
| Registered, but every upload fails | Check the log for TLS/handshake errors and tell Claude. (The SNI fix should prevent the usual one) |
| Reports arrive, no position | Indoors: put it by a window or outside for the first GPS fix |
| Data arrives but nothing on the Fleet page | Not paired yet (step 5) |
| Old settings seem to stick (wrong APN/Wi-Fi) | Settings saved by an earlier firmware override ours: ask Claude to erase the flash (`pio run -t erase`) and flash again |

## Security notes (before real customer use)

- Devices are identified only by their ID in the URL; anyone who knows an ID could send fake data. Set
  `DEVICE_AUTO_REGISTER=false` once devices are registered; device authentication comes later.
- The firmware doesn't check the server's certificate yet. OK for a lab, not for production.
- Bluetooth is on (Freematics Controller app). Its commands have no password and can read back the Wi-Fi password.
  Fine on the bench; to be locked down in our firmware work.
