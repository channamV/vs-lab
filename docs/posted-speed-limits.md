# Posted speed limits (on-road vehicles)

Flags on-road vehicles driving over the **posted** limit of the road they're on, not just a fleet or machine top
speed. Limits come from **OpenStreetMap** (free). Craig's decisions, 2026-10-25: on-road vehicles only, OpenStreetMap
for now, a **% tolerance** in Settings, and a running tally of road kilometres with and without a known limit to
decide when paid data (e.g. TomTom) is worth it.

## Setting it up

1. **Settings → Safety rules → Over posted speed limits: tolerance (%)**. E.g. 10 → flagged above 55 km/h in a 50
   zone, 88 in an 80 zone. Blank = off. 0 = any amount over.
2. Tick **On-road vehicle** on each machine that drives on public roads (machine → Edit). It's ticked automatically for
   machines in the *Pickup / light vehicle* and *Dump truck (on-road)* categories (existing ones were set when this
   was released).

## What happens

Every 5 minutes, each on-road vehicle's new GPS readings are:

1. **Matched to the road driven**: the nearest public road within 25 m, using the direction of travel so a
   cross-street or a parallel service road doesn't steal the match. Further than 25 m from a road = off-road (yard,
   worksite): not checked.
2. **Compared with that road's posted limit** plus the tolerance. Per-direction limits are used when the map has them.
3. More than **10 seconds** over → an entry in the **safety log** ("Over posted speed limit": peak speed, the limit,
   the road's name, who was checked in), shown in **Reports → Safety** and sent as the **Over Posted Speed Limit**
   notification (subscribe on the Notifications page).

It runs a few minutes behind real time (it waits for the readings to arrive), and a spell still going is finished
on the next run. The existing **Speeding** rules (fleet, machine and worksite limits) still work as before, in real
time, for every machine.

## Coverage tally

**Settings → Safety rules → Posted speed limit coverage**: road kilometres per month driven by on-road vehicles, split
into **limit known**, **limit unknown** (the road is mapped but has no limit recorded) and **off-road**. Only "limit
known" kilometres can be checked. If that share stays low on your routes, paid map data would catch more; the
switch would only change where limits come from.

## Map data

- Roads come from the public **Overpass API** (OpenStreetMap), downloaded in map squares of about 5 × 4 km and
  stored for a month, shared by all companies. At most 3 squares per run, to be polite to a free service; a vehicle in
  a new area is checked as soon as its squares are downloaded.
- Only a square's corners are sent, never a vehicle's position.
- Limits like "CA:urban" (a default for an area, not a sign) count as unknown: we don't guess.
- Attribution: speed limit data © OpenStreetMap contributors (ODbL).

## Privacy

Entries name the operator checked in at the time, like the other safety log entries: same retention, data download
and erasure ([privacy.md](privacy.md)).

## For developers

- Pure: `platform/src/lib/road-limits.ts` (maxspeed parsing, map squares, grid-indexed matching with heading and
  one-way penalties and sticky roads, spells, coverage; `road-limits.test.ts`).
- Database/job: `src/lib/posted-speed.ts` (`checkPostedSpeeds`; Overpass with `OVERPASS_URL` override; `road_tiles`
  cache; `machines.on_road` / `road_checked_until`; `organizations.posted_limit_tolerance_pct`; `road_coverage` per
  org and month; safety event kind `posted_speeding`, deduped by machine + start; notification `posted_speeding`;
  `posted-speed.test.ts` with a fake Overpass). Cron: `/api/jobs/posted-speed` every 5 min (`vercel.json`), also in
  `npm run watchdog`.
