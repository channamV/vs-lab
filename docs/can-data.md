# Engine (CAN) data

## What we receive today: OBD-II

The stock Telelogger firmware reads **OBD-II** from the vehicle's diagnostic port while the engine runs
(the engine computer is off otherwise) and sends it with each report. VS Lab stores every field it receives
(machine page → latest data) and already uses some of them:

| Field | Used for |
|---|---|
| RPM | Engine on/off (best signal) and idle in Reports (below 1,000 rpm) |
| Engine load %, throttle %, coolant and intake temperature, speed, fuel level % | Stored and shown; not used in reports or alerts yet |

The firmware polls RPM, speed, throttle and engine load about every second, coolant and intake temperature
less often. Machines without OBD fall back to battery voltage and vibration to tell the engine is running.

## What we don't receive yet: J1939

Most heavy equipment (excavators, loaders, dozers, trucks) doesn't speak OBD-II. Its engine computer talks
**J1939** on a CAN bus, usually at the round 9-pin Deutsch diagnostic connector. J1939 is where the
valuable construction data is: true engine hours, fuel used and fuel rate, DEF level, engine load, coolant,
and active fault codes (the ISO 15143-3 / AEMP data in Veristart Insights' Telematics page).

The Freematics ONE+ hardware can listen to a CAN bus, but the stock Telelogger doesn't decode J1939. Getting it
needs:
1. A cable: 9-pin Deutsch (J1939) to the device's OBD-II socket.
2. Our firmware fork: listen to the J1939 broadcast messages (no polling needed; engines broadcast them),
   pick out the ones we want, and send them as extra fields in the normal report.
3. Platform: name and store those fields, then use them (true engine hours, fuel, fault-code alerts).

Step 3 is built (2026-10-21) and tested with the simulator; steps 1–2 wait for the hardware.

### What the platform does with J1939 (built)

Craig's first list: true engine hours, fuel rate and fuel used, coolant temperature, active fault codes (plus
RPM, engine load and DEF level, which come in the same messages).

- **Engine on/off and idle** use J1939 RPM when it's there (before OBD RPM, voltage or vibration).
- **Machine page → Engine computer (J1939)**: hour meter, fuel rate, total fuel used, coolant, engine load, DEF
  level, active fault codes in plain words (e.g. "Engine coolant temperature: above normal (most severe) ·
  SPN 110 FMI 0") with the dash lamps that are on, and recently cleared faults.
- **Fleet list**: a "⚠ 1 fault code" badge.
- **Notifications**: new event type **Engine Fault Code**, once each time a fault appears.
- **Reports**: "Fuel used" tile and a Fuel used column (L and L/h), from the engine's own fuel meter; the
  Machines CSV also has the hour meter hours for the period.
- Cleared fault history is deleted with the GPS track (retention, [privacy.md](privacy.md)).

### Wire format for our firmware fork

Extra fields in the normal Telelogger report (`PID:value`), in a range the stock firmware doesn't use:

| PID | Field | J1939 source |
|---|---|---|
| 301 | Engine total hours (h) | SPN 247 |
| 302 | Fuel rate (L/h) | SPN 183 |
| 303 | Total fuel used (L) | SPN 250 |
| 304 | Coolant temperature (°C) | SPN 110 |
| 305 | Engine speed (rpm) | SPN 190 |
| 306 | Engine load (%) | SPN 92 |
| 307 | DEF tank level (%) | SPN 1761 |
| 310 | Active faults: SPN × 32 + FMI each, `;`-separated; `0` = none | DM1 |
| 311 | Lamps: 1 malfunction, 2 red stop, 4 amber warning, 8 protect | DM1 |

The fault list is only sent when the firmware has a fresh DM1 message; a report without it leaves the open
faults as they are. Parser: `platform/src/lib/freematics/protocol.ts`; fault wording: `platform/src/lib/j1939.ts`.

## Simulating it

`npm run simulate` makes a mixed fleet:
- machine 1 of every 3 sends **OBD-II**: RPM (working ~1,500–2,100, idle ~750–850), engine load, throttle,
  coolant warming up to ~90 °C, intake temperature, speed, fuel level slowly dropping;
- machine 3 of every 3 (the 24 V one) sends **J1939**: hour meter and total fuel counting up while running,
  fuel rate (~15–24 L/h working, ~3 L/h idle), coolant, RPM, load, DEF level;
- `--fault` makes the J1939 machines report a coolant temperature fault (SPN 110 FMI 15, amber lamp) after a
  minute of running, clearing two minutes later;
- `--obd all|none` and `--j1939 all|none` change who sends what.
