# Store and replay (location history without signal)

**Goal:** a complete location history. When a machine has no cellular signal, the device keeps its readings and
sends them, oldest first, once it's back in coverage. VS-lab then shows them at the time they happened, not the time
they arrived. This is a **core requirement** (decided 2026-10-25), on hold until the car tests are done.

Status: step 1 done (VS-lab dates readings by when they were taken, 2026-10-25). Step 2 (device) is next: see the
"Firmware to-do" in [hardware-bringup.md](hardware-bringup.md). Step 3 not started.

---

## How it works today

The stock firmware was built to show "where is it now", not a full history.

| What | Today |
|---|---|
| How often it records | Every 1 s while moving, 2 s after 10 s still, 5 s after a minute still; sleeps after 3 min still |
| Room in memory | About 1,000 readings (the 8 MB extra memory is on in our builds) |
| Order it sends in | **Newest first** |
| If a send fails | That batch is **thrown away** |
| When it goes to sleep | Memory is **wiped** |
| If the power is cut | Everything in memory is lost |
| Memory card | Everything is written to it, but **never sent** from it |
| VS-lab | Dates each reading by **when it was taken** (GPS time, else device uptime) since 2026-10-25. Before that, by arrival time, so late readings landed at the wrong time |

So today a 20-minute dead zone loses most of those 20 minutes, even though the memory could hold them.

---

## Options

| Option | What it means | Holds without signal | Survives power cut | Effort |
|---|---|---|---|---|
| **A. Record less often** | Every 10–15 s instead of 1–5 s. A one-line setting | Memory lasts about 10× longer | No | Very small |
| **B. Keep and replay from memory** | Keep failed readings, send oldest first, don't wipe on sleep | About 3–4 hours at one reading every 10–15 s | No | Medium |
| **C. Replay from the memory card** | Keep a "sent up to here" marker on the card, send everything after it | Weeks or months (the card has ~30 GB) | **Yes** | Larger |
| **D. Send in batches** | Record as often as you like, but send several readings together every 10–15 s | Same as B or C | Same as B or C | Small, on top of B or C |

**Recommended path (in order):**
1. ✅ **VS-lab: use the device's GPS time** for each reading (done 2026-10-25, see "Step 1 as built" below).
2. **Device: option B plus D.** Keep failed readings, send oldest first, don't wipe on sleep, and send in batches
   every 10–15 s. Covers the common case (dead zones of minutes to hours) and cuts data use.
3. **Device: option C** when we need to survive power cuts or very long outages (for example, a machine parked for
   days out of coverage, or the battery disconnected).

Option A on its own is a quick win but loses detail (exact worksite entry and exit times, short speeding bursts)
without fixing the throw-away and wipe behaviour.

---

## Costs

- **Cellular data and Soracom requests.** Each upload today is one HTTPS request through Soracom Beam, roughly
  0.3–0.5 KB including headers. At one per second that's about 3,600 requests and ~1.5 MB per hour of driving. Sending
  in batches every 15 s cuts it to about 240 requests per hour, and the data roughly in half, since headers are sent
  once per batch. Check Soracom's current prices for data (plan01s) and Beam requests to put dollars on it.
- **Development.** Step 1 is small (a day or less). Step 2 is a few working sessions with bench and car tests. Step 3
  is the largest: card wear, a corrupted card, and the device restarting mid-write all need handling.
- **Detail.** At 10–15 s between readings, a machine moving at 10 km/h travels about 30–40 m between points. That's
  fine for equipment on a site, coarse for road vehicles.

---

## Step 1 as built (2026-10-25)

Found by Craig on the first drive: parked in a lot, the map and replay fanned out from the parking spot to points along
the earlier route. The drive's backlog arrived after the parked readings and, dated by arrival, was mixed in with them.

- Each reading gets `telemetry.recorded_at` (`src/lib/telemetry/sample-time.ts`, tested). Telelogger sends the GPS time
  of day (PID 0x10, `HHMMSScc` UTC) but **not the date**, so the date is today's, or yesterday's if that would be more
  than 10 minutes in the future. Readings without a fix use the uptime difference (PID 0) from a GPS reading in the
  same upload, else from the newest reading (taken as now). Never later than arrival.
- A GPS time more than 6 hours old is treated as a bad clock and ignored (`SAMPLE_TIME_RULES.maxBacklogMs`); raise it
  when the device keeps longer backlogs (steps 2 and 3).
- Ingest handles an upload's readings oldest first. An upload whose newest reading is more than 2 minutes old is a
  **late backlog**: stored for history, but it doesn't move the current position or change engine state, worksite,
  safety or battery checks (those would otherwise act on old readings as if they were happening now).
- The machine page map, location history and replay, the battery chart and the CSVs go by `recorded_at`. Readings from
  before the change keep their arrival time, so tracks recorded before it can still show the fan.
- Still by arrival time: reports, fuel checks, posted speed limits (in arrival batches, ordered by `recorded_at` within
  one), retention.

## Things to decide or check

- **How often to record** for equipment versus road vehicles (could differ per machine type, or be changed from
  VS-lab later with the device commands the platform already supports).
- **How long a gap must be covered:** minutes, hours or days. This decides between steps 2 and 3.
- **Custom circuit board:** if we design our own board, pick storage that survives power cuts (flash memory) with
  this in mind.
- **Duplicates:** a reading sent twice (for example, the reply was lost) must not be counted twice. VS-lab should
  ignore repeats by device and GPS time.

Details of the current firmware behaviour: [hardware-bringup.md](hardware-bringup.md), Findings 5.
