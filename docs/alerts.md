# Alerts and arm/disarm

Part of Tier 2, Safety & Access Monitoring. The machine always starts. The platform watches and tells
you when something's wrong, on the **Alerts** page and by email.

## What raises an alert

Only machines whose service level is **Safety & Access Monitoring** (machine page → Settings).

| Alert | When | How often |
|---|---|---|
| **Unauthorized use** | The machine is **armed** and its engine has been running for **5 minutes** with nobody checked in (or the last operator checked out 5+ minutes ago). | Once per engine-on period |
| **Checklist issues** | An operator answered "Not OK" to any pre-start checklist item. Includes their notes. | Once per check-in |
| **Operator not approved** | The operator isn't on the machine's approved list. | Once per check-in |
| **Not confirmed at machine** | The operator's phone was more than 100 m from the machine, or they didn't share their location. | Once per check-in |

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

## Setting up email (Resend, free)

About 10 minutes. Resend's free plan allows 3,000 emails a month (100 a day).

1. Sign up at **resend.com** with the email address that should receive alerts.
2. **API Keys → Create API Key**: name it `vs-lab`, permission *Sending access*. Copy the key
   (starts with `re_`). It's only shown once.
3. In Vercel → `vs-lab-platform-tpj9` → **Settings → Environment Variables**, add (tick Production and Preview):
   - `RESEND_API_KEY` = the key
   - `ALERT_EMAIL_TO` = your email address (several addresses: separate with commas)
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
