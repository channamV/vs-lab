# Windows PC setup

About 30 minutes. You only do this once.

## 1. Check what's already installed

Open **PowerShell** (Start menu → type "PowerShell") and run each line. You should see a version number for each.

```powershell
git --version        # Git for Windows
claude --version     # Claude Code
node --version       # Node.js — must be v22 or newer
```

For PlatformIO: open **VS Code**. You should see an ant-head icon in the left sidebar. Click it.
The first time, it finishes installing itself, which takes a few minutes. Wait until it says it's ready.

Anything missing:

| Missing | Install from |
|---|---|
| Git | git-scm.com → Download for Windows (accept the defaults) |
| Claude Code | code.claude.com → follow the Windows install steps |
| Node.js | nodejs.org → **LTS** version (accept the defaults) |
| PlatformIO | VS Code → Extensions (Ctrl+Shift+X) → search "PlatformIO IDE" → Install |

Close and reopen PowerShell after installing anything.

> **Shortcut:** in PowerShell, `cd` to the repo folder (step 2), run `claude`, and ask:
> *"Check my PC setup against docs/windows-setup.md and fix anything missing."*
> Claude will run these checks for you.

### If PowerShell says "running scripts is disabled on this system"

Windows blocks `npm` by default on some PCs. Run this once:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

## 2. Get the code

```powershell
cd $HOME\Documents
git clone https://github.com/channamV/vs-lab.git
cd vs-lab\platform
npm install
```

`npm install` downloads the libraries the platform uses. It takes 1–3 minutes.

## 3. Run the platform

```powershell
npm run dev
```

Open **http://localhost:3000** in your browser. You'll see an empty Fleet page.

Leave that window running. Open a **second** PowerShell window:

```powershell
cd $HOME\Documents\vs-lab\platform
npm run simulate
```

Three simulated machines appear on the map within a few seconds and move around Toronto-area
jobsites. Click one to see its details, rename it, or change its service level.
Press **Ctrl+C** in either window to stop it.

Your data is kept in `platform\.data\`. Delete that folder to start fresh.

## 4. Working with Claude Code on your PC

From the `vs-lab` folder, run `claude`. Useful first requests:

- *"Explain how a device report gets from the Freematics into the database."*
- *"Add a column to the fleet table showing how long each machine has been running today."*
- *"Run the checks and tell me if anything is broken."*

Claude reads `CLAUDE.md` automatically. That file tells it how this project is put together.

Before any change is saved to GitHub, Claude should run `npm run check`, which runs the linter, type checks and tests.
The same checks run automatically on GitHub for every change.
