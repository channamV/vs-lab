# Location history, replay and battery voltage

Two views modelled on Veristart Insights ("Location History" and the "Telematics Input" voltage graph), rebuilt for
vs-lab with a few improvements.

## Battery voltage (machine page)

Every machine's page has a **Battery voltage** section, for the last **24 hours**, **7 days** (default) or **30 days**:

- **Latest, lowest, highest and average** reading, and whether it's a **12 V or 24 V** system (detected the same way
  as the low battery warning).
- The chart: the **line** is the average, the **pale band** each moment's lowest–highest reading. A short dip (an
  engine cranking, a sagging battery) always shows, even on 30 days. Insights keeps every Nth reading instead, which
  can hide dips.
- **Grey shading** is when the engine was running. Charging reads about 13.8–14.4 V (27.6–28.8 V on 24 V);
  a healthy resting battery about 12.4–12.7 V (24.8–25.4 V).
- The **dashed line** is the low battery level (11.9 V / 23.8 V). A brief dip below it while cranking is normal; a
  resting reading below it is not (and raises the Low battery warning).
- **Gaps** in the line: the device wasn't reporting.
- Hover for the exact values; **CSV** downloads what the chart shows.

Limitation: the stock firmware reports while the machine runs or moves. A parked machine's battery overnight needs
firmware change #7 (voltage in the 15-minute parked check-ins, [firmware/README.md](../firmware/README.md)).

## Location history and replay

Machine page → **Location history & replay** (on the map). Choose **Last hour / 8 hours / 24 hours / Today /
Yesterday / 7 days / 30 days**, or a custom range (up to 31 days), in the company time zone.

- **Summary:** distance, engine running time, stops, top speed, number of positions.
- **Map:** the track, a green **start** and red **end** dot, and dark dots for **stops** (5 minutes or more in the same
  place, engine on or off). Click the track for the time, speed, heading, engine state and the **operator checked in**
  at that moment. Worksites can be shown underneath.
- **Gaps:** where the device went silent and the machine reappeared elsewhere, the line breaks instead of drawing a
  straight line across (we don't know the way it went).
- **Replay:** ▶ Replay plays the trip with a moving arrow. Choose the speed (1 min to 2 h per second), **Skip parked
  time** (nights and long silences play in a moment), **Follow machine** (the map keeps it in view), or drag the
  slider. The bar above the map shows the time, speed, engine and operator as it plays.
- **Stops table:** when, how long, what the engine did (*Engine off*, *Idled 45 min*, or *Engine running* when
  it worked in place), and who was checked in; **Show** zooms to it, **Replay from here** starts there.
- **CSV:** every position shown (time, coordinates, speed, heading, engine, operator).

Long periods are thinned to one position per time slice so the page stays fast (a note says so); pick a shorter
period for every detail.

Improvements over Insights: no 500-point cut-off (Insights' "All Trails" silently ends early on long ranges), gaps
shown as breaks, stops with engine state, operator at each point, skip-parked-time replay, speed always in km/h,
and data limited to the signed-in user's company and divisions (Insights' data functions don't check who's asking).

Not yet: several machines on one map with a shared replay, and frequent-location clusters (Insights' Job Sites).

## Privacy

Positions are telemetry: deleted after the company's telemetry retention period ([privacy.md](privacy.md)). The
history shows which operator was checked in, so the check-in privacy notice mentions location history.

## For developers

- `platform/src/lib/history.ts` (database: `voltageHistory` per-slice min/max/avg with `GROUP BY floor(epoch/slice)`,
  `locationHistory` with `DISTINCT ON` thinning above `HISTORY_RULES.maxTrackPoints`) and the browser-safe
  `history-track.ts` (ranges, outliers, segments, stops, replay timeline). Tested in `history.test.ts`.
- UI: `src/components/VoltageChart.tsx` (SVG, hover, sr-only table), `machines/[id]/BatteryHistory.tsx`,
  `machines/[id]/history/` (page, `HistoryReplay.tsx`, CSV `export`), battery CSV at `machines/[id]/battery/export`.

## Reading times (2026-10-25)

Points are placed by **when the reading was taken** (the device's GPS time), not when it reached VS-lab. The device
sends readings it couldn't send earlier newest first, after the newer ones; before this change those late points were
mixed in with the current ones and the track fanned out from where the machine was parked. Tracks recorded before the
change can still show this. Details: [store-and-forward.md](store-and-forward.md).
