# Safety rules: speeding, restricted areas, idling, operator fatigue

These four rules work with the stock Telelogger firmware and the data we already receive. Each occurrence goes
in the **safety log** (Reports → **Safety**, downloadable as CSV) and raises a notification you can subscribe
to (**Notifications** page). They apply to every machine with a paired device, whatever its service level.

Set the limits on **Settings → Safety rules** (owners). Leave a box empty to turn that rule off.

| Rule | Default | Notification |
|---|---|---|
| Fleet speed limit (each machine can have its own top speed) | off | **Speeding** |
| Excessive idling after | 30 minutes | **Excessive Idling** |
| Operator hours per day | 12 hours | **Operator Fatigue** |
| Operator hours without a break | 5 hours | **Operator Fatigue** |
| Restricted areas | draw them on the Worksites page | **Restricted Area Entered** (also an alert) |

## Speeding

- **What counts:** GPS speed more than 2 km/h over the limit for **more than 10 seconds**. Shorter spikes are
  ignored, because a single bad GPS reading can show a jump in speed. Readings from fewer than 4 satellites are
  ignored too.
- **Which limit applies:**
  - The **fleet limit** from Settings.
  - A machine can have its **own top speed** (Edit machine → *Top speed*), e.g. 25 km/h for a loader, or 100 km/h
    for a pickup. It replaces the fleet limit for that machine, whether it's higher or lower.
  - A worksite can have its **own limit** (Worksites → Edit details → *Speed limit*), e.g. 15 km/h in a yard.
    Inside the site, its limit applies when it's lower than the machine's (or fleet) limit. In several
    overlapping sites, the lowest applies.
- **What's recorded:** one entry per spell, with the top speed, the limit, the operator checked in and the site.
  - A spell ends when the speed drops back under the limit.
  - It also ends if the device stops reporting for more than 5 minutes.
- **Practical note:** most heavy equipment can't exceed ~40 km/h. The fleet limit matters most for trucks and
  pickups. Site limits matter for yards and jobsites with pedestrians.

## Restricted areas (exclusion zones)

- **Setting one up:** draw a worksite and choose the type **Restricted area (exclusion zone)**. It shows in dark
  red on the map. Examples: a rail corridor, an excavation edge, a neighbour's property, a buried utility line,
  a public road the equipment mustn't use.
- **When a machine enters one, at once:**
  - an **alert** (Alerts page and email),
  - a **Restricted Area Entered** notification,
  - an entry in the safety log.
- **How often:** one alert per entry. The log records when the machine left.
- **Notes:** the site's notes are copied into the alert. Use them for the instruction, e.g. "No equipment
  without a flagger".
- **Later:** with our own firmware and the starter relay (Safety & Access Control), the same zones could stop a
  machine being started inside a restricted area. This is the "geo-lock" idea.

## Excessive idling

- **What counts:** the engine is running **below 1,000 rpm** and the machine isn't moving (under 2 km/h), for
  longer than the limit. Working (higher RPM, or moving) resets the clock. So does stopping the engine.
- **What's recorded:** one entry per stretch, with how long it lasted in the end.
- **Needs engine RPM** from OBD-II or J1939 (see [can-data.md](can-data.md)). Without RPM, a running excavator
  that's digging but not driving looks the same as one idling, so we don't guess.
- **Why it matters:** idling burns fuel (typically 3–5 L/h for heavy equipment) and adds engine hours (wear and
  service intervals) for no work. Reports → Machines shows total idle hours.

## Operator fatigue

Worked out every 5 minutes, from **check-ins** and **engine time**. An operator's time is the time a machine's
engine was running while they were checked in on it, across all machines.

- **Long day:** more than the daily limit since midnight (company time zone). Once per operator per day.
- **No break:** more than the limit without a break of **15 minutes or more**. Engine-off periods shorter than
  15 minutes don't count as a break. Once per stretch.

This depends on operators checking in, so it works best alongside the pre-start checklist. It measures machine
time only. It doesn't know about driving to site or other work. Treat it as a prompt for a conversation, not
proof of fatigue.

## Privacy

The safety log names operators. It follows the same rules as check-ins ([privacy.md](privacy.md)):
- it's deleted after the check-in retention period;
- it's included in an operator's data download;
- an erased operator's name is removed from it.

## Testing with the simulator

```powershell
npm run simulate -- --speeding                   # running machines drive at ~50 km/h for 30 s every 2 minutes
npm run simulate -- --idle --obd all --engine on  # engines idle and never work → Excessive Idling after the limit
```

For speeding, first set a fleet limit (e.g. 40 km/h) in Settings. For idling, set the limit to 5 minutes to see
it quickly.

## Coming next (needs our own firmware)

Harsh braking, harsh acceleration, impacts and rollover/tilt. They need the device's motion sensor read many
times a second, which the stock firmware doesn't do (it averages the readings). They'll go in the same safety
log.

## Settings for developers

`SAFETY_RULES` in `platform/src/lib/safety.ts` holds the speed margin, the 10-second grace period, the idle
RPM, the break length and the limits Settings accepts.
