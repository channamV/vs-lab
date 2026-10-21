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

Step 3 can be built and tested with the simulator before the hardware work, once we've picked the first
messages to support.

## Simulating it

`npm run simulate` now sends OBD-II data from machine 1 of every 3 (a mixed fleet): RPM (working ~1,500–2,100,
idle ~750–850), engine load, throttle, coolant warming up to ~90 °C, intake temperature, speed and fuel level
slowly dropping. `--obd all` makes every machine send it, `--obd none` turns it off.
