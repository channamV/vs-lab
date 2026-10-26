# Maintenance

Work items for each machine: repairs reported on pre-start checklists, scheduled services, devices gone quiet, and
anything staff add. Craig's request 2026-10-26, modelled on the Veristart Insights (Lovable) maintenance module, with
some of its gaps fixed (listed at the end).

**Where:** Operations → **Maintenance**. Everyone signed in can look; owners and managers can change things (people
limited to some divisions only see and work on those divisions' machines). Each machine's page has a "Checklist and
maintenance" section too.

## Tabs

| Tab | What it shows |
|---|---|
| **By machine** (default) | Every machine with open items or a service coming due, worst first. Each card shows the machine's items as coloured pills (tap to open), services due or due soon, and "N open · M resolved today". Headline numbers on top; filter by worksite (machines there now). One column on a phone. |
| **Issues** | Open items by status (New, In progress, Awaiting parts) plus those resolved in the last 7 days. Four columns on a computer; stacked on a phone. Cards show number, priority, title, machine, where it came from, age and a photo. |
| **Service schedules** | Every schedule with its state (Due / Due soon / OK / Needs a reading), next due, the machine's current reading and where that reading came from. "Start service now", "Edit", and a box to record a meter reading. |
| **History** | Every item opened in a date range (filter by machine, open/resolved, where from) with a CSV download: the machines' service record. |

## The issue card

One column, built for a mechanic's phone:
- Number (#1001 … per company), priority, status, title, machine, where it came from and when.
- **Where**: the place the machine was when it was reported (town name, opens Google Maps), where it is now if it
  has moved, and the worksite.
- **Checklist reports**: every checklist that reported it, oldest first: when, which operator, the answer, the
  operator's note and their photos (tap to enlarge). Links to the full checklist.
- **The three C's**: Complaint (what was reported), Cause (what was found), Correction (the work done). Who did the
  work (our technician / outside vendor, with vendor names remembered). Service items also ask for the machine's
  reading at the service.
- **Save** and **Mark resolved** stay at the bottom of the screen on a phone. Resolving needs all three C's (checked
  on the server, whichever way it's resolved).
- **Photos and files**: add photos (shrunk on the phone) or PDFs to the complaint, cause or correction.
- Other open items on the same machine, and the **activity** log in words ("Status: New → In progress", who, when).
- Delete (managers): for items opened by mistake. Finished work should be resolved, not deleted.

## Where items come from

| Source | When | Priority |
|---|---|---|
| **Checklist** | An operator reports a defect. | Minor / Major; **Locked out** if they locked the machine out. |
| **Service schedule** | A schedule comes due (checked every 5 minutes and whenever a reading comes in). | Service due |
| **Device** | A paired machine hasn't reported for 72 hours. Resolved automatically when it reports again. | Device offline |
| **Added by staff** | "+ New item" (or "+ Maintenance item" on the machine page). | Chosen |

Priorities, most urgent first: Locked out, Major, Service due, Minor, Device offline, Low. Staff can change them.

### No duplicates

There's at most **one open item per machine for the same thing**: the same checklist question, the same schedule, or
the machine's connectivity. When a defect is reported again before it's fixed (broken glass Monday, reported again
Tuesday), the second checklist is **added to the open item** as another report, with its note and photos; the count
goes up and nothing new is opened. If it's reported as more serious (e.g. Major after Minor), the priority goes up
and a "Repair needed" alert goes out again. Once the item is resolved, the next report opens a new item.
A resolved item can be reopened (change its status), unless a newer item for the same thing is already open.

### Lockout

When an operator locks a machine out for repair, the defect's item is **Locked out**. Resolving the machine's last
open Locked out item **clears the lockout**, so operators can check in again (managers can still clear it from the
machine page as before).

## Service schedules

A schedule is "every N hours, N km and/or N months (or days), whichever comes first", e.g. 250-hour service, or
oil change every 10,000 km or 6 months.
- **Due soon** in the last 10% of an interval (50 h of a 500 h service, 18 days of 6 months). **Due** once any limit
  is reached: a "Service due" item opens by itself (and a **Service Due** notification goes to anyone subscribed).
- When creating one, "last done" (date, hours, km) is optional: the first due counts from there, or from today and
  the machine's current reading.
- **Resolving the service item moves the schedule on**: next due = reading at the service + interval (and the service
  date + months). The reading at the service defaults to the machine's current reading and today.
- "Start service now" opens the item early (it's the same item the schedule would open, so never a duplicate).
- Untick **Active** to pause a schedule.

## Meter readings

Every pre-start checklist now asks for the **hour meter** (or the **odometer in km** for machines marked on-road).
- If the machine's device reads it from the engine computer (J1939 hours today; odometer once the firmware sends it,
  see [hardware-bringup.md](hardware-bringup.md) to-do 8), the answer is **filled in** and the operator corrects it if
  the meter shows something else. Otherwise it shows the last known reading as a hint.
- Staff can record a reading on the Service schedules tab or the machine page. Service items record theirs.
- **Current hours** (used for schedules): the engine computer's hour meter when the device reads it; otherwise the
  latest reading given plus the engine time VS-lab measured since (marked "estimated"). Kilometres: the vehicle's
  odometer if read, else the latest reading given.

## Town and province on checklists

A written checklist answer can start as the town and province ("Mount Pearl, NL"): in the checklist editor choose
**Written: town, province (filled in)**. The ready-made NL trip inspection's "Place of inspection" works this way. It
starts from the machine's GPS position; when the operator's phone shares its location, it's updated to theirs (unless
they've already typed something). They can always change it. Names come from OpenStreetMap (Nominatim, free), kept
per ~1 km square for 6 months (`src/lib/places.ts`); if the lookup fails the answer is just empty.

## Privacy

Maintenance items are the machine's service history and are kept (not part of the nightly clean-up). Reports keep the
answer and note after their check-in is deleted, but lose the operator's name and photos. Erasing an operator removes
their name from items and reports. See [privacy.md](privacy.md).

## What's different from the Lovable version

Fixed: priority on repeat reports only goes up; resolving needs the three C's however it's resolved; service date
defaults to the day it's resolved (not the day it opened); "Start service now" can't duplicate the schedule's item;
offline items close themselves; schedules combine hours/km/time and warn "due soon"; km schedules work; access is
checked on the server for every company and division; photos stay in our private storage; the activity log is in
words with who did it. Not built (yet): the map on the dashboard, drag-and-drop between columns (change the status on
the card instead), a vendor list screen, a printable PDF report (History has the CSV).

## Code

`platform/src/lib/maintenance.ts` (items, checklist defects, schedules, connectivity; tested), `maintenance-types.ts`
(labels, priorities, due rules; browser-safe, tested), `maintenance-queries.ts` (page reads), `meters.ts` (readings),
`places.ts` (town names). Pages in `src/app/(admin)/maintenance/`; files served by `/maintenance/files/<id>`. Tables:
`maintenance_issues` (replaced `checklist_issues` 2026-10-26, same ids), `maintenance_reports`,
`maintenance_attachments`, `maintenance_activity`, `maintenance_schedules`, `meter_readings`, `place_names`.
