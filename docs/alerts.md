# Alerts

Part of Tier 2, Safety & Access Monitoring. The machine always starts. The platform watches and tells
you when something's wrong, on the **Alerts** page and by email.

## What raises an alert

Only machines whose service level is **Safety & Access Monitoring** (machine page → Settings).

| Alert | When | How often |
|---|---|---|
| **Unauthorized use** | The machine is **Access-Controlled** ([operating-modes.md](operating-modes.md)) and its engine has been running for **5 minutes** without anyone checking in for that run. Operators are checked out automatically when the engine has been off longer than the break allowance (30 minutes for web check-ins), so a start after that needs a new check-in. | Once per engine-on period |
| **Repair needed** | A pre-start checklist reported a minor or major defect that isn't already an open issue on the machine, or reported an open one as more severe. Repeats stack on the issue without a new alert. Says if the machine was locked out. See [checklists.md](checklists.md). | Once per check-in, only for new or escalated issues |
| **Operator not approved** | The operator isn't on the machine's approved list. | Once per check-in |
| **Not confirmed at machine** | The operator's phone was more than 100 m from the machine, or they didn't share their location. | Once per check-in |

**Restricted area entered**: a machine entered a worksite marked as a restricted area (exclusion zone). Every
machine with a device, once per entry: see [safety.md](safety.md).

**Possible tamper** alerts (a tracking device that went quiet, lost power, moved while quiet or reports a different
vehicle) apply to every machine with a device: see [tamper.md](tamper.md).

The unauthorized-use check runs each time the machine reports, so the alert arrives within a few
seconds of the 5 minutes passing. If the device loses signal, the alert waits until it reports again.

## Operating modes (replaces arm and disarm)

Machine page → **Operating mode**: **Access-Controlled** (the unauthorized-use alert applies), **Unlocked** (e.g. a
mechanic's service visit: no check-in needed; for 1, 4 or 8 hours, until 6 AM, until a time, or until changed) or
**Locked** (any start or movement alerts straight away: **Started while Locked**, **Moved while Locked**). Timed changes
go back by themselves. See [operating-modes.md](operating-modes.md).

## Handling alerts

**Alerts** in the top bar shows a red count of open alerts, and the Fleet page shows a banner.
On the Alerts page, add a note if useful (e.g. "mechanic testing hydraulics") and click
**Acknowledge**. Acknowledged alerts stay in the list below as a record.

## Who gets emails: subscriptions

Each person chooses what they're emailed about: **Notifications** in the menu (the *My subscriptions* page). The page works like the
production portal's notification subscriptions.

**A subscription has:**
- **Name**, e.g. "Weekend machine starts".
- **Event types** (click the chips). Hover over a chip, or look below the chips, for what each one means.
  - Machine Start / Machine Stop
  - Start Without Checklist (unauthorized use), Checklist — Repair Needed, Operator Not Approved,
    Check-in Not at Machine (these four are also listed on the Alerts page)
  - Equipment Created / Updated, Operator Assigned / Revoked (someone added a machine, changed one, or changed
    its approved operators)
  - Entered Worksite / Left Worksite / Stayed Too Long at Worksite: with these, a **Worksites** box lets you
    pick which worksites (empty = all). See [worksites.md](worksites.md).
  - **Low Battery Warning** (replaced production's "Switched to Battery Power", 2026-10-21): see below.
  - **Engine Fault Code**: the engine computer reported a new fault (J1939 machines; see [can-data.md](can-data.md)).
  - **Possible Fuel Theft** (also an alert) and **Refuelled**: see "Fuel" below.
  - **Start While Locked** and **Unauthorized Machine Movement** (also alerts), and **Operating Mode Changed**:
    see [operating-modes.md](operating-modes.md).
  - **Scheduled Change Late** (also an alert): see [schedules.md](schedules.md).
  - **Speeding**, **Excessive Idling**, **Operator Fatigue** and **Restricted Area Entered** (also an alert):
    see [safety.md](safety.md).
  - The greyed-out dashed chips are production event types VS Lab can't detect yet (movement, equipment
    removed, lock/unlock).
- **Machines** and **Operators**: search and tick. Leave a list empty for "all". If the company uses divisions,
  you can also pick whole divisions.
  - With operators ticked, events without an operator (e.g. Start Without Checklist) don't match.
- **Schedule** (empty = any time): days, plus From/To times in the company's time zone (Settings → Time zone and schedules).
  - A window that ends before it starts runs overnight. 18:00 to 06:00 means after hours, and the early-morning
    part counts as the day it started: "Fri 18:00–06:00" covers Friday night into Saturday morning.
- **Delivery:** email, to the person's sign-in address. It isn't editable, so nobody can redirect alerts to an
  outside address. Text messages could come later.

**The subscriptions page** lists your subscriptions with an on/off switch (pause without deleting), Edit and
Delete. On the right, **Last 24 hours** shows recent events on machines you can see, and for each one which of
your subscriptions it matched and whether it was emailed.

**Rules:**
- Owners and managers start with an *All alerts* subscription (the four alert types, all machines), the same
  as before. Viewers start with none, but can add their own.
- Owners can manage anyone's subscriptions: **Users → Subscriptions** under the person's name.
- People are only ever emailed about machines they can see. Division limits always apply.
- One email per person per event, listing which of their subscriptions matched. Every email links back to the
  subscriptions page.
- Editing a paused subscription leaves it paused.

## Fuel: theft alerts and the refuelling log

Machines that report their **fuel level** (from the engine computer: J1939 on most heavy equipment, OBD-II on
light vehicles) get three checks. They apply to every machine with fuel data, whatever its service level.
Enter each machine's **fuel tank size** (Edit machine) to get litres, and the third check.

**1. Fuel taken while parked → "Possible fuel theft" alert.** The tank level when the engine **starts** is
lower than when it last **stopped**:
- fuel level only comes in while the ignition is on, so it compares the last readings before the stop with the
  first readings after the start, once the level has settled (2 minutes);
- only readings taken while the machine is **stopped** (under 3 km/h) count, in all three checks: fuel sloshing while
  driving moves the reading a lot (a car's 38% read as 50%, logged as a false refuel on 2026-10-28);
- the **median** of up to 15 readings each side, so one odd reading doesn't count;
- at least **5% of the tank** and, with the tank size, at least **20 L**. One check per engine start.

**2. Refuels → the fuel log** (and the *Refuelled* notification, if you subscribe). The level went **up** by at
least 8% of the tank (and 20 L with the tank size): while parked (compared at the next start) or while running
(checked every 5 minutes). With the tank size, the litres added.

**3. Fuel lost while running → "Possible fuel theft (while running)" alert.** On J1939 machines with a tank
size: every 5 minutes, the drop in the tank since a reference point (renewed at least hourly) is compared with
the fuel the **engine's own meter** says it burned. If the tank lost at least 5% (and 20 L) more than the engine
burned, fuel is going somewhere else: siphoning while the machine idles, or a leak. Once per engine-on period.
OBD-II machines don't report fuel burned, so this check needs J1939.

Both alerts go to the Alerts page and to *Possible Fuel Theft* subscribers (included in "All alerts"). Every
refuel and suspected theft is in the machine's **Fuel** section and in **Reports → Fuel** (per machine, plus
the full fuel log, both downloadable as CSV).

Sensor accuracy varies with the machine and with parking on a slope, so treat the alerts as "go and check".
Settings: `FUEL_RULES` in `platform/src/lib/fuel.ts`.

## Low battery warning

With the engine off, a healthy battery rests at about 12.6 V (25.2 V on 24 V machines). Below **11.9 V**
(**23.8 V**) it's roughly a quarter charged and the machine may not start. VS Lab:
- only uses readings taken with the **engine off** (running readings are lifted by the alternator);
- ignores readings under **8 V**: the device isn't on machine power then (USB on a desk reads about 3.6 V, or a
  bench supply);
- needs the low reading to still be low **3 minutes later**, so the dip while cranking doesn't count;
- sends **one warning per low spell** (event type *Low Battery Warning*, subscribe under Notifications), and
  shows "⚠ Low battery" on the fleet list and machine page;
- clears it once an engine-off reading is at least 0.4 V above the warning level (e.g. after charging).

While parked, the device sleeps and checks in every 15 minutes. With our firmware (2026-10-26) each check-in
carries the battery voltage (`&BV=`), so a battery draining while parked is caught before the next start (VS-lab
reads it since 2026-10-27; it also shows on the machine's Battery voltage chart). The stock firmware doesn't send it,
so with it readings come only from just after stopping and just before starting. Settings:
`BATTERY_RULES` in `platform/src/lib/battery.ts`.

## Setting up email (Resend, free)

About 10 minutes. Resend's free plan allows 3,000 emails a month (100 a day).

1. Sign up at **resend.com** with the email address that should receive alerts.
2. **API Keys → Create API Key**: name it `vs-lab`, permission *Sending access*. Copy the key
   (starts with `re_`). It's only shown once.
3. In Vercel → `vs-lab-platform-tpj9` → **Settings → Environment Variables**, add (tick Production and Preview):
   - `RESEND_API_KEY` = the key
   - `ALERT_EMAIL_TO` (optional) = extra addresses that get every organization's alerts (Veristart staff).
     Everyone else gets what they subscribe to (see above).
4. **Deployments → ⋯ → Redeploy.**
5. On the **Alerts** page click **Send test email**. It says "Sent to …" or explains what's wrong.

**Sending to other people:** until you verify a domain, Resend only delivers to the address you signed
up with. To alert others: Resend → **Domains → Add Domain** (e.g. `alerts.yourdomain.com`), add the DNS
records it shows, then set `ALERT_EMAIL_FROM` = `VS Lab <alerts@alerts.yourdomain.com>` in Vercel and redeploy.

**If alerts land in Junk:** normal at first for a new sending domain.
- In Outlook, mark the email **Not junk**, or add the sender under *Settings → Mail → Junk email → Safe senders*.
- Add a DMARC record at your DNS provider (GoDaddy for veristart.ai): type **TXT**, name `_dmarc`,
  value `v=DMARC1; p=none;`. Mail servers trust domains with one more.
- For several Microsoft 365 recipients, an admin can allow the domain in Microsoft Defender's
  *Tenant Allow/Block List*.

Each alert shows its email result: *Emailed*, *Email failed* (hover for the reason) or *Not emailed
(email not set up)*.

## Testing with the simulator

Set a simulated machine (e.g. SIM00001) to Safety & Access Monitoring, make sure nobody is checked in, then:

```powershell
npm run simulate -- --host https://vs-lab-platform-tpj9.vercel.app --devices 1 --engine on
```

`--engine on` keeps the engine running (normally the simulator switches it on and off every few
minutes). After 5 minutes an "Unauthorized use" alert appears and is emailed. Ctrl+C to stop.

## Tuning

The 5-minute grace period is `ALERT_RULES` in `platform/src/lib/alerts.ts`. The location and
timing thresholds are `CHECKIN_RULES` in `platform/src/lib/operators.ts`.
