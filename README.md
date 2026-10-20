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

## Quick start

```
cd platform
npm install
npm run dev          # http://localhost:3000
npm run simulate     # in a second terminal
```
