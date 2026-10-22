# Operating modes: Access-Controlled, Unlocked, Locked

Every machine has one of Veristart's three operating modes. What a mode *does* depends on the machine's service
level. Only **managers and owners** can change modes (and Veristart staff).

| Mode | GPS & Telematics | Safety & Access Monitoring | Safety & Access Control (relay) |
|---|---|---|---|
| **Access-Controlled** | not offered (no check-ins) | Running 5 min with nobody checked in → **Unauthorized use** alert | The relay only allows a start for an approved, checked-in operator |
| **Unlocked** | Normal tracking | Anyone can use it without checking in; usage is still recorded | The relay always allows a start, like a normal key |
| **Locked** | **Alarmed**: any engine start or movement → alert straight away | Any start or movement → alert straight away; check-ins refused | The relay prevents starting. A running engine is never stopped. |

New machines start **Access-Controlled**. On GPS & Telematics that behaves as Unlocked, so upgrading a machine to
Safety & Access Monitoring starts it Access-Controlled.

## Changing the mode

**Machine page → Operating mode**:
1. Choose the mode.
2. Choose how long:
   - until changed again;
   - 1, 4 or 8 hours;
   - until 6 AM;
   - until a date and time.
   A timed change goes back to the earlier mode by itself.
3. Add a reason if you want one (e.g. "mechanic visit", "long weekend").

The **Fleet** page shows each machine's mode under its service level. **Recent changes** on the machine page lists
who changed what, and when.

Every change also raises an **Operating Mode Changed** notification (subscribe on the Notifications page).

Replaces arm/disarm (2026-10-22):
- armed became Access-Controlled;
- disarmed became Unlocked (with the same end time, if it had one).

### Locked out for repair (safety lock)

When an operator reports a major defect and locks the machine out ([checklists.md](checklists.md)), the machine
counts as **Locked** until a manager clears it. Clearing it is done in the red banner on the machine page. It then
returns to its normal mode. A safety lock is never undone by a timer or the offline fallback.

## Alerts for Locked machines

- **Started while Locked:** the engine started (once per engine run).
- **Moved while Locked:** the machine is more than 100 m from where it was when it was locked, engine on or off. That
  catches it being towed or carried away on a trailer. Once per lock.
- Both are on the Alerts page and in the **Start While Locked** and **Unauthorized Machine Movement** notifications
  (in everyone's "All alerts" subscription).

## Offline fallback (machines with an ignition relay)

A relay machine decides for itself when it can't reach us. Each machine has a choice, in **Operating mode → When
offline**: after **N hours** without a connection, either

- **keep the current mode.** Most secure. A Locked machine stays locked, and a new operator added while it's
  offline can't start it until it reconnects. Or
- **switch to a mode from the same list.** For example Unlocked, so crews aren't stranded. Every start is still
  recorded and uploaded when it reconnects.

This is the manager's choice between **access** and **security**. Notes:
- A machine locked out for repair always stays locked.
- Someone could block the signal on purpose to trigger the fallback. Choose "keep" for machines at high theft risk.
- The machine page says when a relay machine has been offline long enough to have probably switched.

Today's machines run the stock firmware without a relay, so the setting is recorded now and used once relay devices
run our firmware.

## For the firmware (technical)

- **Command:** each change is sent to a relay machine's device as a command
  ([device-commands.md](device-commands.md)): `MODE=<access_controlled|unlocked|locked><TAB><offline mode or keep><TAB><hours>`.
  A newer one replaces one the device hasn't answered.
- **Answer:** the device answers `ok=1` once it's enforcing the mode. The platform records `confirmed_mode` and the
  machine page shows "confirmed" or "waiting for the machine to confirm".
- **What the firmware must do:**
  - **Keep locally** the mode, the offline rule, and the approved operators (as scrambled credentials).
  - **Never cut a running engine:** act at the next start.
  - **Offline:**
    - after the hours without contact, switch to the offline mode (unless locked out for repair);
    - return to the cloud's mode on reconnection;
    - report the switch.
  - **Later, ways in while offline:**
    - a one-time override code from the portal (the device checks it with its own key; each code works once);
    - a phone passing an updated operator list or an unlock pass over Bluetooth;
    - a sealed bypass switch, reported as tamper when used.
- **Code:** `platform/src/lib/modes.ts` and `mode-types.ts` (tested).
- **Simulator:** `npm run simulate` answers MODE commands like the firmware should.

## Schedules

Automatic mode changes by day and time (e.g. Locked on nights and weekends) and temporary operator access:
see [schedules.md](schedules.md).
