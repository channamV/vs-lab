# Alerts and arm/disarm

Part of Tier 2, Safety & Access Monitoring. The machine always starts. The platform watches and tells
you when something's wrong, on the **Alerts** page and by email.

## What raises an alert

Only machines whose service level is **Safety & Access Monitoring** (machine page → Settings).

| Alert | When | How often |
|---|---|---|
| **Unauthorized use** | The machine is **armed** and its engine has been running for **5 minutes** without anyone checking in for that run. Operators are checked out automatically when the engine has been off longer than the break allowance (30 minutes for web check-ins), so a start after that needs a new check-in. | Once per engine-on period |
| **Repair needed** | A pre-start checklist reported a minor or major defect that isn't already an open issue on the machine, or reported an open one as more severe. Repeats stack on the issue without a new alert. Says if the machine was locked out. See [checklists.md](checklists.md). | Once per check-in, only for new or escalated issues |
| **Operator not approved** | The operator isn't on the machine's approved list. | Once per check-in |
| **Not confirmed at machine** | The operator's phone was more than 100 m from the machine, or they didn't share their location. | Once per check-in |

**Possible tamper** alerts (a tracking device that went quiet, lost power, moved while quiet or reports a different
vehicle) apply to every machine with a device: see [tamper.md](tamper.md).

The unauthorized-use check runs each time the machine reports, so the alert arrives within a few
seconds of the 5 minutes passing. If the device loses signal, the alert waits until it reports again.

## Arm and disarm

Machine page → **Monitoring**. A Safety & Access Monitoring machine is **armed** by default.
Disarm it when the engine will legitimately run with nobody checked in, e.g. a mechanic's service visit:
**1 hour**, **4 hours**, **until 6 AM** tomorrow, or **until re-armed**. Timed disarms re-arm
automatically. While disarmed, there are no unauthorized-use alerts. Check-in alerts still work.
The Fleet page shows "Disarmed" under the machine's level.

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
  - The greyed-out dashed chips are production event types VS Lab can't detect yet (movement, equipment
    removed, lock/unlock).
- **Machines** and **Operators**: search and tick. Leave a list empty for "all". If the company uses divisions,
  you can also pick whole divisions.
  - With operators ticked, events without an operator (e.g. Start Without Checklist) don't match.
- **Schedule** (empty = any time): days, plus From/To times in the company's time zone (America/Toronto).
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

## Low battery warning

With the engine off, a healthy battery rests at about 12.6 V (25.2 V on 24 V machines). Below **11.9 V**
(**23.8 V**) it's roughly a quarter charged and the machine may not start. VS Lab:
- only uses readings taken with the **engine off** (running readings are lifted by the alternator);
- needs the low reading to still be low **3 minutes later**, so the dip while cranking doesn't count;
- sends **one warning per low spell** (event type *Low Battery Warning*, subscribe under Notifications), and
  shows "⚠ Low battery" on the fleet list and machine page;
- clears it once an engine-off reading is at least 0.4 V above the warning level (e.g. after charging).

Limitation with the stock firmware: the device sleeps a few minutes after the engine stops and its
15-minute check-ins don't include the voltage, so readings come from just after stopping and just before
starting. Adding the voltage to the check-ins is on the firmware list (`firmware/README.md`). Settings:
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
