# Product tiers — what we're building

Mirrors the Veristart offering (one platform, three levels, chosen per machine). This lab builds
**Tier 1** and **Tier 2** on the Freematics ONE+ Model H. Tier 3 (starter relay) is deferred.

| | Tier 1: GPS & Telematics | Tier 2: Safety & Access Monitoring | Tier 3: Safety & Access Control |
|---|---|---|---|
| Promise | See where equipment is and how it's used | Know who is operating; alert on unauthorized use | Physically enforce the rules |
| Hardware | Device on diagnostic port | Same device, plus operator ID (beacon / phone) | Plus starter-control relay |
| Stops a start? | No | No: detects, alerts, buzzes | Yes |
| Lab status | **Working** (position, engine on/off, engine hours, battery, signal) | **Working on the platform** (operators, QR check-in, checklist, alerts, operating modes). Next: firmware (buzzer, BLE beacons) | Deferred |

## Tier 1 — GPS & Telematics (built)

- GPS location and 24-hour track ✅
- Last report, battery voltage, cellular signal, connection events ✅
- Raw machine telemetry stored (motion, OBD-II where available) ✅
- Engine on/off ("run state") and engine hours per day ✅
- Still to add: activity reports, idle vs. working time, CSV export

**How engine-on is detected** (`platform/src/lib/telemetry/engine.ts`). Many heavy machines have
no OBD-II port (J1939 or none), so we infer "engine running" from data the stock device already
sends, best signal first:
1. **OBD RPM**, when the machine provides it (300 RPM or more means running).
2. **Alternator voltage:** a running engine charges the battery. This works without OBD too (the device
   measures its own supply), so it needs the device powered from the machine's 12/24 V: readings under 8 V
   (USB or a bench supply) are ignored.
   - 12 V machines: 13.2 V or more means running
   - 24 V machines (most heavy equipment): 26.4 V or more means running. The system type is picked automatically from the voltage.
3. **Vibration** from the accelerometer, only if neither of the above is available. The device sends it with
   gravity removed (about 0;0;0 when still), so a reading of 0.05 g or more means running. Weak signal: the
   device averages it, so a smooth idle may not register, and a parked machine can be bumped. Devices built
   without OBD (e.g. `bench-beam`) send no voltage, so they rely on this.

If a device keeps reporting but nothing it sends shows the engine state (e.g. GPS only) for 10+ minutes, the
Fleet and machine pages show the engine as **Unknown** rather than its last state.

Each on-period is stored as an **engine session**. If a running machine's device goes quiet for
10+ minutes, the session is ended at its last report rather than counted until it reappears.
Engine hours per day are counted in the company's time zone (Settings → Time zone and schedules).

**To verify on real machines:** the voltage thresholds are standard values but haven't been
checked against our equipment yet. A battery charger or a weak alternator can fool voltage
detection. Spot-check against hour meters during the first device trials.

## Tier 2 — Safety & Access Monitoring (in progress)

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
- **Operating modes** per machine (Access-Controlled / Unlocked / Locked, timed changes; [operating-modes.md](operating-modes.md))

**4. Records.** Operator sessions, checklist results, alerts and acknowledgements make up the audit trail.

### Build order

1. ~~Run-state detection + engine hours (platform only)~~ ✅ done
2. ~~Operators, machine assignments, QR check-in page, pre-start checklist, phone-location check and
   engine-start timing rule (platform only)~~ ✅ done, see [operator-checkin.md](operator-checkin.md)
3. ~~Arm/disarm + unauthorized-use rules + email alerts (platform only)~~ ✅ done, see [alerts.md](alerts.md)
4. **First firmware work:** command channel from the server to the device (the server's reply to each
   report can carry a command), used for the buzzer
5. **Firmware:** BLE beacon scanning, reported with each sample. An approved operator's beacon checks
   them in (check-in `method` = `ble`, no break allowance)
6. Device authentication (signed device credentials), so data can't be faked

Steps 1–3 need no firmware changes. They work with the stock Telelogger and the simulator.

## Tier 3 — Safety & Access Control (deferred)

Needs a starter-control relay output, which the ONE+ doesn't have straight from the box. When we
get there: bench setup first (relay module plus an LED), offline authorization with signed digital
keys, and a qualified review of the wiring before anything goes into a real machine.
