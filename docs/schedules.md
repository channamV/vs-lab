# Schedules

Schedule changes you'd otherwise make by hand (Jira V1-267). **Operations → Schedules.**

Version 1 has two actions:
- **Machine Mode**: set machines to Access-Controlled, Unlocked or Locked ([operating-modes.md](operating-modes.md)).
- **Operator Access**: give operators access to machines for a set period. Their permanent approvals don't change.

Examples: lock every machine on weeknights 6 PM–6 AM and all weekend; unlock two machines for an open house;
give a subcontractor crew access to a loader for three weeks.

## Kinds of schedule

| Kind | When | Notes |
|---|---|---|
| **One-time** | A start and an end date/time | Machine Mode can have **no end**: the mode stays until someone changes it |
| **Weekly** | Chosen days, a From–To time (or all day), between optional start and end dates | A window like 18:00–06:00 runs **overnight** into the next morning |
| **Temporary override** | Starts now or at a set time; lasts 1/2/4/8 hours, until end of day, or until a set time | Beats regular schedules while it runs. Optional email 15 minutes before it ends |

- **Start and end, not two separate actions.** Every schedule has a start and an end.
- **End behaviour** (Machine Mode) says what happens when a window ends:
  - **Return to the previous mode**. For overrides this is "resume normal": back to whatever regular schedules call
    for, or the earlier mode.
  - **Set to a specific mode**.
- **Timezone.** Each schedule runs in its own timezone, shown on the form. The default is the **fleet timezone**
  (Settings → Schedules). Times follow daylight saving: "6 PM" stays 6 PM local all year.

## The form

- **Layout:** name and Active/Paused, action, machines and operators, schedule, end behaviour.
- **Schedule Preview:**
  - what will happen, in plain English;
  - the next windows;
  - any **conflicts** with your other active schedules, with how they'll be resolved.
- **Permissions:** you only see actions you're allowed to do by hand. Today that's managers and owners, for the
  machines in their divisions. The same check runs when you save, and again every time the schedule runs. If the
  person responsible loses that permission, the schedule stops making changes.

## When schedules overlap

1. A **temporary override** beats regular schedules.
2. Between schedules of the same kind, the company's rule decides. **Least restrictive wins** by default
   (Unlocked, then Access-Controlled, then Locked), so work isn't blocked by mistake. Veristart staff can change a
   company to "most restrictive wins" (Settings → Schedules).
3. **Scheduled operator access beats a scheduled Locked.** The machine is Access-Controlled during the overlap, so
   those operators can start it.
4. When a window ends, the remaining active schedules are checked before anything reverts.

## Changing things by hand

- **A manager changes a machine's mode during a window:** their change stands until the **next** window starts.
  Nothing reverts at the end of the current window.
- **Pause:** stops future changes. Machines keep the mode they're in.
- **Delete a schedule that's in effect:** it ends straight away, and its end behaviour is applied (unless another
  schedule applies).
- **Duplicate:** copies a schedule, paused, for editing.

## The list and Upcoming

- **The list shows** each schedule's status:
  - In effect (and until when);
  - Scheduled (next run);
  - Paused;
  - Completed.
- **Conflicts:** the list flags them in red. Filter by Active, Paused or Conflicts.
- **Upcoming** lists every scheduled change in the next 7 days, in the fleet timezone, with counts in effect, next
  24 h and conflicts.

## History and alerts

- **History:** every automatic change appears in the machine's **Operating mode → Recent changes**, attributed to
  the schedule (e.g. *Schedule "Weeknight lockdown"*). It also raises an **Operating Mode Changed** notification.
- **Late changes:** machines with an ignition relay get each change as a command at their next connection; unlocks
  go first. If one hasn't confirmed within **10 minutes**:
  - a **Scheduled change is late** alert is raised (and notification, in "All alerts");
  - the change still waits for the machine to reconnect.
- **No relay:** machines without a relay don't need to confirm. The platform applies their mode itself.

## How it runs

- **Every minute:** Vercel Cron calls `/api/jobs/schedules`.
  - Changes happen within a minute of the scheduled time.
  - Saving, pausing or deleting a schedule applies at once.
  - On your own computer, `npm run watchdog` runs it once.
- **Out of scope for version 1:**
  - storing schedules on the device or running them offline (the device follows the cloud; see the offline fallback
    in [operating-modes.md](operating-modes.md));
  - showing operators their temporary access in an app;
  - schedule templates.
- **Code:**
  - `platform/src/lib/schedule-time.ts`: windows, descriptions, conflicts (browser-safe).
  - `platform/src/lib/schedules.ts`: saving, permissions, the scheduler.
  - Both are tested.
