# VS Lab

A lab environment for connected-equipment software and firmware: equipment visibility,
operator monitoring and (later) access control.

**Status:** Tier 1 (GPS & Telematics) is working end to end. A Freematics ONE+ running stock firmware,
or the built-in simulator, reports position, battery, signal and motion data to the platform.

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

## Quick start

```
cd platform
npm install
npm run dev          # http://localhost:3000
npm run simulate     # in a second terminal
```
