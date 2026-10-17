# Freematics ONE+ Model H setup

Goal: the device, running **stock Freematics firmware**, reports to **your** platform instead of
Freematics' demo server. No code changes, just settings.

## What you need

- Freematics ONE+ Model H (SIM7670 LTE Cat 1)
- Micro SIM with a data plan. An IoT SIM like Soracom is easiest. Note the **APN** your provider gives you.
- USB cable (the one that came with the device)
- For bench testing: a **12 V OBD-II bench power adapter**. USB power is enough to flash and for Wi-Fi testing.
  The cellular modem can draw more power than USB supplies when it transmits.
- Antennas attached (GPS and cellular) **before** powering on

## 1. Your platform needs a public HTTPS address

The device reaches your platform over the internet, so `localhost` won't work. Two options:

| Option | When | How |
|---|---|---|
| **Deploy** (recommended) | You want it running all the time | Follow [deploy.md](deploy.md). Your address will be something like `vs-lab-xyz.vercel.app` |
| **Temporary tunnel** | Quick test against your PC | Install `cloudflared`, run `cloudflared tunnel --url http://localhost:3000`, and use the `….trycloudflare.com` address it prints. It changes every time you run it. |

Check it works. Open this in a browser, replacing the host:
`https://YOUR-HOST/hub/api/notify/TEST0001?EV=7` → it should show **OK**, and a device "TEST0001" appears on the Fleet page.

## 2. Connect the device to your PC

1. Plug the device into your PC over USB.
2. Open **Device Manager** (right-click Start) → **Ports (COM & LPT)**.
3. You should see something like *USB-SERIAL CH340 (COM5)* or *Silicon Labs CP210x (COM5)*. Note the COM number.
4. If it's under "Other devices" with a yellow warning instead, it needs a driver:
   - CH340: search "CH340 driver Windows" (from wch-ic.com)
   - CP210x: search "CP210x driver" (from silabs.com)
   - Or ask Claude Code on your PC: *"My Freematics shows as an unknown device in Device Manager, help me install the driver."*

## 3. Configure and flash the firmware

The easiest route is **Freematics Builder**, a Windows tool from Freematics. Download it from
freematics.com or from the GitHub releases at github.com/stanleyhuangyc/Freematics/releases.

1. Open Freematics Builder and pick the **telelogger** project / Freematics ONE+ target.
2. Set the options:

| Setting | Value |
|---|---|
| Enable OBD | On if testing in a vehicle; **off** on the bench (avoids OBD retry delays) |
| Enable Motion Sensor | On |
| GNSS | Standalone GNSS |
| Storage | None (or MicroSD if a card is fitted) |
| Cellular Network APN | Your SIM provider's APN (e.g. Soracom: `soracom.io`) |
| WiFi Network | **On for first tests.** Enter your Wi-Fi or phone-hotspot name and password |
| Server Host | Your host, **without** `https://`, e.g. `vs-lab-xyz.vercel.app` |
| Server Port | `443` |
| Transport Protocol | **HTTPS POST** |
| Enable PSRAM | On (Model H has PSRAM, so the device can buffer more data while offline) |

3. Select the COM port from step 2 and click **Build & Upload** (or equivalent). It takes a couple of minutes.
4. Open the **serial monitor** at **115200** baud. You'll see the device's log.

**Alternative (PlatformIO, the route Claude uses):** on your PC, ask Claude Code:
*"Clone the Freematics repo into firmware/vendor, set up telelogger for my Model H with server
YOUR-HOST, port 443, HTTPS POST, APN X, Wi-Fi Y, then build, flash it on COM5 and watch the serial output."*
Claude edits `config.h`, runs the build and upload, and reads the log for you.

## 4. What a healthy log looks like

Roughly, in order:

```
[WIFI] Connecting...  / [CELL] SIM7670 ...       ← network coming up
LOGIN(your-host:443)...                          ← device announces itself
[GNSS] ...                                       ← GPS starting (first fix can take 1–5 min outdoors)
[WIFI] /hub/api/post/XXXXXXXX                    ← sending data; XXXXXXXX is the device ID
[HTTP] OK 1                                      ← your platform accepted it
```

The device appears on your Fleet page under its 8-character device ID. GPS needs a view of the sky.
Put the device by a window or outside for the first fix.

## 5. Then test over cellular

Once Wi-Fi works, turn Wi-Fi **off** in the settings (or move out of range) and re-flash. Then
watch for `[CELL]` lines and `OK` replies.

### Known risk: HTTPS over the SIM7670 modem

Over cellular, the stock firmware uses the modem's built-in HTTPS client. Modern hosts (Vercel,
Cloudflare) require a TLS feature called **SNI**. Some SIMCom modems leave it off by default.
If Wi-Fi works but cellular shows connection or handshake errors on every send, that's the likely
cause. The fix is one line added to the firmware (`AT+CSSLCFG="enableSNI",0,1`). That will be our
first firmware change. Ask Claude Code to make it and flash it.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| No COM port appears | Charge-only USB cable, or driver missing (step 2) |
| Upload fails "port busy" | Serial monitor is open — close it, then upload |
| `[CELL]` errors, no network | Wrong APN, SIM not activated, antenna not attached, or not enough power on USB |
| Logs in, but no position | Indoors; wait for a GPS fix by a window |
| Platform shows device but data stops | Check the device's log; check Vercel → Logs for errors |
| `Unknown device` replies | `DEVICE_AUTO_REGISTER=false` is set and the device isn't registered yet |
| Device reports, but isn't on the Fleet page | It's new, so it's *unclaimed*: Platform page → assign it to your organization |

## Security notes for later (before real customer use)

- Devices are identified only by their ID in the URL. Anyone who knows an ID could send fake data.
  Set `DEVICE_AUTO_REGISTER=false` once your devices are registered. Device authentication comes in a later phase.
- The stock firmware doesn't verify the server's certificate. That's acceptable for a lab, not for production.
