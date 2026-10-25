# VS Lab

A lab environment for connected-equipment software and firmware: equipment visibility,
operator monitoring and (later) access control.

**Status:** Tier 1 (GPS & Telematics) is working end to end. A Freematics ONE+ running stock firmware,
or the built-in simulator, reports position, battery, signal and motion data to the platform.
The platform works out when each engine is running and counts engine hours per day.
Tier 2 (Safety & Access Monitoring) works on the platform side: operators check in by scanning a QR
sticker on the machine, entering a PIN and completing the pre-start checklist, and the platform alerts
(on screen and by email) on unauthorized use and check-in problems.

| Folder | Contents |
|---|---|
| [`platform/`](platform/) | Web platform and device API (Next.js, TypeScript, PostgreSQL) |
| [`firmware/`](firmware/) | Device firmware notes and roadmap |
| [`docs/`](docs/) | Setup and how-to guides |

## Guides

1. [Windows PC setup](docs/windows-setup.md) — get the platform running on your PC
2. [Freematics device setup](docs/freematics-setup.md) — configure, flash and connect the ONE+ Model H
3. [Deploying to the internet](docs/deploy.md) — Vercel + Neon, about 20 minutes
4. [Product tiers](docs/product-tiers.md) — what we're building and in what order
5. [Operators and QR check-in](docs/operator-checkin.md) — set up operators, approvals and QR stickers
6. [Alerts and arm/disarm](docs/alerts.md) — what raises an alert, and setting up email
7. [Organizations, users and sign-in](docs/organizations-and-users.md) — customers, roles, platform admins
8. [Machines and devices](docs/machines-and-devices.md) — equipment vs tracking hardware, pairing and device swaps
9. [Pre-start checklists](docs/checklists.md) — templates, answers, defects that stack, lockout for repair
10. [Tamper and connectivity alerts](docs/tamper.md) — quiet devices, concern levels, the 5-minute watchdog
11. [Privacy (GDPR)](docs/privacy.md) — retention, operator data download and erasure, privacy notice, access log
12. [Worksites (geo-lock)](docs/worksites.md) — draw sites on a map; enter, leave and stayed-too-long notifications
13. [Reports](docs/reports.md) — engine hours, idle, utilization, operators, checklist compliance, worksites; CSV
14. [Engine (CAN) data](docs/can-data.md) — the OBD-II data we receive, J1939 for heavy equipment, simulating it
15. [Device commands](docs/device-commands.md) — sending commands to devices (buzzer, Wi-Fi, reporting rate…), signing
16. [Safety rules](docs/safety.md) — speeding (fleet, machine and site limits), restricted areas, excessive idling, operator fatigue
17. [Firmware updates](docs/firmware-updates.md) — uploading releases, sending them to devices in stages, what the firmware must do
18. [Privacy in Canada](docs/privacy-canada.md) — PIPEDA/Quebec checklist, gaps against Veristart's privacy policy, breach register
19. [Operating modes](docs/operating-modes.md) — Access-Controlled / Unlocked / Locked per machine, alarmed GPS mode, offline fallback
20. [Schedules](docs/schedules.md) — automatic mode changes (nights, weekends) and temporary operator access, conflicts, Upcoming
21. [Training and certifications](docs/training.md) — operators' records, expiry reminders, auto-grant and required training at check-in
22. [Scan to fill](docs/scan-to-fill.md) — photo of a training card or serial plate fills the form (Claude); setting up the API key
23. [Location history and battery voltage](docs/location-history.md) — replay trips, stops, battery voltage chart
24. [Posted speed limits](docs/posted-speed-limits.md) — on-road vehicles over the road's posted limit (OpenStreetMap), coverage tally

## Quick start

```
cd platform
npm install
npm run dev          # http://localhost:3000
npm run simulate     # in a second terminal
```
