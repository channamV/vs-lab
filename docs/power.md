# Device power: measuring and saving

**Why** (Craig, 2026-10-30): an Access Control device must stay awake to notice an operator's beacon, and Veristart's
production device (always on, modem always connected) drains batteries. Goal: keep unlocking quick while cutting the
power a parked machine's battery loses. Measure first, then build what saves the most.

## Response times we want to keep

| How the operator unlocks | Target |
|---|---|
| Bluetooth beacon or phone app | a few seconds, any time, no signal needed |
| QR check-in, mode change from VS-lab | within about a minute in working hours; slower at night is acceptable |
| Tamper, movement while parked | at once (the motion sensor wakes the device) |

## Ideas (to rank once measured)

1. **Parked state** for relay devices, ~10 minutes after the engine stops: GPS off, a reading every few minutes
   instead of every second, engine-computer link in low power, CPU at 80 MHz.
2. **Modem asleep or off between check-ins** with VS-lab instead of always connected: poll every 30–60 s in the
   company's working hours (VS-lab knows them), every 15 min at night.
3. **Bluetooth listening in short bursts** (e.g. 30 ms of every 500 ms instead of 37.5 ms of every 50 ms), with
   beacons set to transmit about twice a second: unlocking stays within 1–3 s at a fraction of the power.
4. **Wake fully on activity**: motion (an operator climbing in) switches to full listening and fast polling.
5. **Battery guard** from the parked voltage (`&BV=`): below ~12.2 V poll less; below ~11.8 V modem off, beacons and
   phone app only. The device must never be what stops a machine from starting.
6. **Beacons and the phone app first** for Access Control (they don't need the modem); QR is the slower fallback.

## Measuring on the desk

**Meter:** a USB power meter between the laptop and the device's USB cable. It must **pass data through** (the
laptop talks to the device during the test) and show current to 1 mA or better, ideally with a running mAh total.
The device runs on USB's 5 V here; in a vehicle it runs from 12 V through its own converter, so vehicle current is
roughly the USB figure × 5 / 12 ÷ 0.8 (converter losses, estimate). Confirm in a vehicle later with a 12 V meter.

**Firmware:** the relay build with `VSLAB_TEST_POWER` (`pio run -e bench-beam-relay` with
`PLATFORMIO_BUILD_FLAGS=-DVSLAB_TEST_POWER`). Parts are switched by typing on the serial port (Claude does it with
`serial_cmd.py`): `net pause|run` (no network traffic, modem stays connected), `modem off|on`,
`scan full|low|off|on`, `adv off|on` (phone-app advertising), `gps off|on`, `obd off|on`, `cpu 80|160|240`, `status`.

**Sequence** (about 2 minutes each, reading the meter's average or mAh at the end of each):

| # | State | Commands | Current (mA at 5 V) |
|---|---|---|---|
| 1 | Everything on, as the relay build runs today | — | |
| 2 | No network traffic, modem still connected | `net pause` | |
| 3 | Modem off | `modem off` | |
| 4 | + Bluetooth listening in short bursts | `scan low` | |
| 5 | + no Bluetooth listening | `scan off` | |
| 6 | + no phone-app advertising | `adv off` | |
| 7 | + GPS off | `gps off` | |
| 8 | + engine-computer link in low power | `obd off` | |
| 9 | + CPU at 80 MHz | `cpu 80` | |
| 10 | Proposed parked state: modem off, short bursts, advertising on, GPS off, OBD low, 80 MHz | `scan low`, `adv on` | |

Each part's draw is the difference between two rows. Then: battery days = usable battery Ah ÷ (vehicle current in
A × 24), with usable ≈ half the battery's rating (a lead-acid battery shouldn't go below ~50%).

## Results

Not measured yet.
