# Product tiers — what we're building

Mirrors the Veristart offering (one platform, three levels, chosen per machine). This lab builds
**Tier 1** and **Tier 2** on the Freematics ONE+ Model H. Tier 3 (starter relay) is deferred.

| | Tier 1: GPS & Telematics | Tier 2: Safety & Access Monitoring | Tier 3: Safety & Access Control |
|---|---|---|---|
| Promise | See where equipment is and how it's used | Know who is operating; alert on unauthorized use | Physically enforce the rules |
| Hardware | Device on diagnostic port | Same device, plus operator ID (beacon / phone) | Plus starter-control relay |
| Stops a start? | No | No: detects, alerts, buzzes | Yes |
| Lab status | **Working** (position, battery, signal, motion) | Next | Deferred |

## Tier 1 — GPS & Telematics (built)

- GPS location and 24-hour track ✅
- Last report, battery voltage, cellular signal, connection events ✅
- Raw machine telemetry stored (motion, OBD-II where available) ✅
- Still to add: **run-state / utilization** (engine-on hours per day), activity reports, CSV export

**Run-state from the stock firmware, without OBD.** Many machines have no OBD-II port (J1939 or
none), so we infer "engine running" from data the device already sends:
- **Battery voltage:** above ~13.2 V means the alternator is charging, so the engine is running.
  About 12.6 V or below means it's off.
- **Vibration / motion** from the accelerometer, as a second signal.
- **OBD RPM**, when the machine provides it, overrides both.

## Tier 2 — Safety & Access Monitoring (next)

The "alarm system" model: the machine always starts, and the platform watches.

**1. Know when the machine is operating.** Run-state from Tier 1.

**2. Know who is operating.** Two ways, both without a native app:

| Method | How | Works on | Notes |
|---|---|---|---|
| **QR check-in** (first) | Operator scans a QR sticker on the machine → mobile web page → signs in → completes pre-start checklist → checked in for the shift | Any phone (iPhone + Android) | No firmware change. The phone needs signal at check-in. |
| **BLE beacon** (second) | Operator carries a beacon fob; the device scans for nearby beacons and reports which are present | Device-side, any phone | Needs a firmware change (BLE scanning). Beacon IDs can be copied, so use it as a convenience signal, not proof of identity. |

Web Bluetooth (phone talks to device directly from a browser) works on Android Chrome only,
not iOS, so it isn't the primary method.

**3. Decide and alert.** When a machine set to *Monitoring* is armed:
- Engine running **and** no authorized operator checked in within N minutes → **unauthorized-use alert**
- Alert goes to the fleet manager (email / SMS / web notification), and optionally **sounds the
  device's buzzer** (the ONE+ has one, which needs a firmware change and a command channel)
- Check-in without a completed pre-start checklist → **compliance alert**
- **Remote arm / disarm** per machine or per site (e.g. disarm during a service visit)

**4. Records.** Operator sessions, checklist results, alerts and acknowledgements make up the audit trail.

### Build order

1. Run-state detection + engine hours (platform only)
2. Operators, machine assignments, QR check-in page, pre-start checklist (platform only)
3. Arm/disarm + unauthorized-use rules + email alerts (platform only)
4. **First firmware work:** command channel from the server to the device (the server's reply to each
   report can carry a command), used for the buzzer
5. **Firmware:** BLE beacon scanning, reported with each sample
6. Device authentication (signed device credentials), so data can't be faked

Steps 1–3 need no firmware changes. They work with the stock Telelogger and the simulator.

## Tier 3 — Safety & Access Control (deferred)

Needs a starter-control relay output, which the ONE+ doesn't have straight from the box. When we
get there: bench setup first (relay module plus an LED), offline authorization with signed digital
keys, and a qualified review of the wiring before anything goes into a real machine.
