# Reports

**Reports** in the menu: how the equipment is used, by whom, whether pre-start checklists are being done,
and time at worksites. Ideas taken from the Dashboard, Telematics and Worksite Analytics pages in Veristart
Insights, limited to what VS Lab's devices actually measure (no fuel, DEF or fault codes yet).

## Choosing what to look at

- **Period:** Today, Last 7 / 14 / 30 / 90 days, This month, Last month, or your own dates (up to 92 days).
  Days are counted in the company's time zone, and the current day counts up to now.
- **Division:** if the company uses divisions. People limited to some divisions only ever see their machines.
- The choices are in the page address, so a report can be bookmarked or sent to a colleague.
- Every table has **Download CSV** (opens in Excel).

## Tabs

**Overview**
- Tiles:
  - **Engine hours**, with the average per machine that ran.
  - **Utilization**: engine hours ÷ planned hours. Planned hours = hours per working day × working days in the
    period × machines. The plan is set by owners under **Settings → Reports** (default 8 h, Monday–Friday).
  - **Idle (estimated)**: see below.
  - **Active machines** (ran at least a minute) out of all machines, and **active operators**.
  - **Checklist compliance**: days a machine ran that had a pre-start check-in ÷ days it ran (the same
    measure as production). 90% or more is good, 50–90% needs attention, below 50% is poor.
- **Engine hours per day**, split into working and idle.
- **Hours by machine** and **hours by operator** (top 15). Hours count for the operator checked in when the
  engine ran; time with nobody checked in is shown underneath.
- **Daily activity**: machines × days, darker = more hours (periods up to 31 days).
- **Not used in this period**: machines that could move to another job, be rented out or sold.

**Machines**: engine hours, idle, days used, utilization, last used, and the worksite where it spent most time.

**Operators**: engine hours, check-ins, machines, days, and check-ins that reported defects.

**Checklist compliance**: per machine, compliance, hours with a checked-in operator, starts without a
check-in (the unauthorized-use alert, on armed Safety & Access Monitoring machines), check-ins and defects,
and the days it ran without a check-in.

**Worksites**: per worksite, engine hours on site, time on site, visits, machines and average visit.

## How idle is worked out

For each machine and day, the report uses the best source available, and says which:

| Source | Shown as | How |
|---|---|---|
| The engine computer's own **idle meter** (J1939, SPN 235) | *engine idle meter* | Idle hours that day straight from the engine: the same figure a dealer reads. Also gives **idle fuel** (SPN 236). |
| **Engine RPM** (J1939 or OBD-II) | *engine RPM* | Share of engine-running reports below 1,000 rpm, applied to the day's engine hours. Measured. |
| Neither (no engine data) | *estimated from movement* (in amber) | Share of engine-running reports where the machine wasn't moving (under 1 km/h). An **estimate**, like Veristart Insights': it overstates idle for machines that work standing still (an excavator digging, a pump). |

The Overview tile is called **Idle** when every machine's figure is measured, **Idle (partly estimated)** (with
the share of hours measured) when some are estimated, and **Idle (estimated)** when none are measured. Days
with engine hours but no device reports (e.g. demo history) count as working. Settings: `REPORT_RULES` in
`platform/src/lib/reports.ts`.

## Fuel

Machines whose device reads the engine computer (J1939, [can-data.md](can-data.md)) add a **Fuel used** tile
and column: litres used in the period from the engine's own fuel meter, and the average litres per engine
hour. With the engine's idle fuel meter, the idle figures also show **idle fuel** (litres burned idling). The Machines CSV also has the engine's hour meter hours for the period.

## Later

- Estimated fuel for machines without engine data (from make/model, as in Insights' Telematics page).
- PDF export of the overview, and emailed weekly reports.
- Worksite travel times and A/B comparison (Insights' Worksite Analytics).
