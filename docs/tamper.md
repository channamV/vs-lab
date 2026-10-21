# Tamper and connectivity alerts

A tracking device that stops reporting may have lost signal, run out of battery, or been unplugged by
someone who wants to use or take the machine unseen. VS Lab watches for this and scores **how concerning**
each case is.

## What a healthy device does

The stock Freematics Telelogger firmware:
- **Machine running:** reports every 1–5 seconds.
- **Parked:** after ~3 minutes standing still it **signs off** and sleeps, then **checks in every 15 minutes**.
- **Unplugged / power cut:** stops instantly, without signing off.

So a healthy device is never quiet for much more than 15 minutes. The **watchdog** checks every paired device
every 5 minutes.

## How concern is scored

| How it went quiet | Starting concern |
|---|---|
| Stopped mid-stream **without signing off** (running, or just parked), quiet 10+ min | **High** (looks like it was unplugged) |
| Signed off normally, then **missed one** 15-minute check-in (quiet 20+ min) | **Medium** |
| Signed off normally, then **missed two or more** (quiet 35+ min) | **High** |

Then each of these moves it **down** a step, because it could explain the silence:
- **weak signal** at the last report (−100 dBm or worse): possible coverage gap;
- **low battery** at the last report (under 11.8 V): may have run flat;
- the device has **gone quiet near here before** (within 300 m) and come back by itself: a known dead spot.

And this moves it **up** a step: an **armed** Safety & Access Monitoring machine, **after hours** (before 6 AM or
after 7 PM local time).

The alert lists the reasons, e.g. *"Stopped reporting at 2:14 AM while the engine was running, without signing
off. Signal was good (−71 dBm). Battery was healthy (13.9 V). Armed machine, after hours."*

## When the device comes back

- The quiet spell closes by itself ("Back online after 42 min quiet").
- **Moved while quiet** (**high**): its first GPS position back is 500 m+ from where it went quiet.
- **Reporting a different vehicle** (**high**): it reports a different VIN than before (moved to another machine).
- **Power interrupted** (**medium**): it restarted without signing off after 2+ minutes without contact
  (unplugged and plugged back in, or the battery was disconnected), even if too short to count as a quiet spell.

## Where you see it

- **Alerts page:** *Possible tamper* alerts for **medium** and **high** concern (and again if an incident escalates
  to high). Low concern doesn't raise an alert.
- **Fleet page:** "⚠ Device quiet (high)" on machines whose device is quiet right now.
- **Machine page → Connectivity and tamper:** every incident with its concern, reasons and how it ended.
- **Subscriptions:** *Possible Tamper* (medium/high; included in the default "All alerts") and *Equipment
  Connectivity Status* (every quiet spell, any concern, and when the device is back online).

Applies to every machine with a paired device, whatever its service level.

## The schedule (Vercel Cron)

The watchdog runs every 5 minutes on Vercel (`crons` in `platform/vercel.json`, calling `/api/jobs/watchdog`).
It needs:
- **Vercel Pro** (the free plan only allows daily schedules; VS Lab is on Pro since 2026-10-21), and
- **`CRON_SECRET`** in the project's environment variables: any long random string. Vercel sends it with each
  call; anyone else calling the address gets "Unauthorized".

On your own computer: `npm run watchdog` (in `platform/`) runs it once.

## Tuning

All thresholds are `TAMPER_RULES` in `platform/src/lib/tamper.ts`. Once the real hardware is in, we'll check
its actual check-in timing and the typical signal and battery at your sites, and adjust.
