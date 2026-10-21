# Worksites ("geo-lock")

Draw your jobsites, yards, offices, customer sites and so on, on a map. VS Lab works out which worksite each
machine is in from its GPS, and can tell you when a machine **enters** a worksite, **leaves** it, or **stays
too long**. Modelled on the Worksites page in Veristart Insights.

## Drawing a worksite (managers and owners who see the whole company)

1. **Worksites** in the menu → **+ New worksite**.
2. Optional: type an address in *Find an address or place* to move the map there.
3. Click the map at each corner of the area. **Undo corner** removes the last one. Double-click, or press
   **Finish**, to close the shape (at least 3 corners). **Esc** or **Cancel** stops.
4. Fill in the name, type (job site, company facility, yard, service facility, fuel depot, customer site,
   other: each has its own colour) and, if you want, a **time limit** in hours and notes. **Save worksite**.

To change one, click it on the map or in the list:
- **Edit details**: name, type, time limit, notes.
- **Edit boundary**: drag the orange corners; click a small light dot on an edge to add a corner there;
  right-click (on a phone, press and hold) a corner to remove it. **Save boundary**.
- **Delete**: removes the worksite and its visit history (notifications already sent stay).

Worksites belong to the whole company (all divisions). Everyone can see them; users limited to some
divisions only see their own machines in them.

## Where they show

- **Worksites page**: the map, the list, and which machines are in each worksite right now.
- **Fleet map** and **machine map**: worksite outlines under the machines (click one to open Worksites).
- **Machine page**: "At worksite: …" under the map, with recent visits.

## Notifications

Under **Alerts → Subscriptions**, three event types:

| Event | When |
|---|---|
| **Entered Worksite** | A machine's GPS position is inside a worksite it wasn't in. |
| **Left Worksite** | The machine is more than 30 m outside the boundary (with how long it was there). |
| **Stayed Too Long at Worksite** | The machine has been there longer than that worksite's time limit (once per visit). |

When one of these is ticked, a **Worksites** box appears: pick the worksites you care about, or leave it
empty for all. The usual machine, operator and schedule filters apply too: for example, "Left Worksite, North
Yard, weekdays 18:00–06:00" is an after-hours movement alert for the yard.

How it decides:
- Every GPS position from a machine's device is checked against the company's worksites as it arrives.
- **30 m leeway** on leaving: GPS wanders a few metres, so a machine parked on the boundary doesn't produce a
  stream of enter/leave messages. It counts as having left once it's clearly outside.
- Positions from fewer than 4 satellites are ignored (too rough).
- Worksites can overlap: a machine can be in a yard *and* the larger job site around it.
- "Stays too long" is checked every 5 minutes (with the tamper watchdog) and on each report.
- If a device stops reporting, the machine stays "in" its last worksite until it reports from somewhere else.
- Redrawing a boundary takes effect at each machine's next GPS position.

Settings are `WORKSITE_RULES` in `platform/src/lib/worksites.ts`.

## Later: geo-lock

"Geo-lock" is the bigger idea: the worksite controls the machine, not just the notifications. For example,
machines can only be started inside their assigned worksite, or are locked automatically when they're in the
yard after hours. That needs the starter relay (Safety & Access Control tier). The worksite data, visits and
enter/leave detection built here are the foundation for it. Other ideas for later: worksite reports (hours
and visits per site, like Insights' Worksite Analytics), and jobsite Wi-Fi settings per worksite
(`firmware/README.md`).

Worksite visits are location history: they are deleted with the GPS track, after the company's retention
period ([privacy.md](privacy.md)).
