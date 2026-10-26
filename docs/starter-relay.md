# Starter relay (Safety & Access Control)

How a "Safety & Access Control" machine stops unauthorized starts: the Freematics device opens or closes a relay in
the machine's **starter** circuit. Craig's go-ahead 2026-10-26, copied from Veristart's production firmware
(`Veristart/veristart-hardware-device`, firmware 4.2.11, same Freematics ONE+ Model H). VS-lab's side is done; the
firmware work is to-do 9 in [hardware-bringup.md](hardware-bringup.md).

## How Veristart's firmware does it (what we're copying)

- **Wiring:** the relay's control input goes to **GPIO26** on the Freematics external socket (upper-left contact),
  GND lower-right; **GPIO12** switches on the socket's VCC contact (upper-right) to power the relay module. The
  built-in LED (**GPIO4**) mirrors the relay, so it's lit only while a start is allowed.
- **GPIO26 HIGH = start allowed (relay closed), LOW = blocked.** It's set LOW at power-up: after a power cut or a
  restart, nobody can start until they're authorized again.
- About 5 times a second it re-decides: allowed when an approved operator is connected with the phone app, or an
  approved operator's beacon is within about 70 cm, or the machine is open access; never when it's disabled.
- The approved list and the open/disabled switches come from the cloud and are kept on the memory card, so it
  works without signal. The device never sleeps.

## Safety rules (for whoever installs it)

- The relay interrupts the **starter only** (the crank signal), never the ignition or fuel. Then opening the relay
  can only stop the *next* start: a running machine is never stopped, whatever the firmware does (restart, update,
  lost signal). "Locked: a running engine is never stopped" in [operating-modes.md](operating-modes.md) depends on it.
- Use a relay that is **open when unpowered**, so a dead or unplugged device blocks starting (that's the point),
  and keep a documented bypass for the mechanic (e.g. a keyed switch) in case of a failed device in the field.

## What VS-lab sends the device

All as signed device commands ([device-commands.md](device-commands.md)), only to machines on the Safety & Access
Control tier with a paired device (`platform/src/lib/relay.ts`, tested):

| Command | When | The device |
|---|---|---|
| `MODE=<mode>\t<offline mode\|keep>\t<hours>` | A manager, schedule or timer changes the mode; a repair lockout starts or is cleared (it counts as Locked) | **Unlocked**: relay closed. **Locked**: relay open, nothing opens it. **Access-Controlled**: relay open unless one of the below allows it |
| `ALLOW=<check-in id>\t<start min>\t<break min>` | An approved operator checked in with the QR code (expires after 15 min if not picked up) | Close the relay. Open it again if the engine hasn't started within `<start min>` (5); while it runs keep it closed; after it stops keep it closed `<break min>` (30) for a restart, then open. A newer ALLOW replaces it |
| `REVOKE=<check-in id>` | A manager ended that check-in, or the operator was deactivated | If that's the current ALLOW: open the relay (a running engine carries on) |
| `ACCESS=<version>\t<beacon>:<operator id>,…` | The machine's approved beacons changed (checked every 5 min and when approvals or operators change) | Keep the list (in flash/SD, survives restarts). An approved beacon within range closes the relay, with no signal needed. Answer with the version |

Who's on the beacon list: active operators with a beacon set on their operator page, approved for the machine
(or the machine has no approval list, or a schedule or certification grants it), and holding any required training.
At most 60 per machine for now.

**Beacon starts are reported:** `GET /hub/api/access/<device>?op=<operator id>&b=<beacon>&t=<unix time>&sig=<sig>`,
signature = first 16 hex of HMAC-SHA256(device key, `access\n<device>\n<op>\n<beacon>\n<t>`). Send it when it
happens, or later if there was no signal (VS-lab accepts up to 24 h late, dated when it happened). VS-lab records a
**beacon check-in** (no checklist, so the "checklist due" beeps play until the operator does one with the QR code).
It always answers 200.

## What operators and managers see

- **Check-in page:** after an approved check-in on a relay machine, "The machine is being unlocked for you"; an
  operator who isn't approved is told the machine won't start for them.
- **Operator page:** "Bluetooth beacon" (e.g. VS-BEACON-20), unique per company.
- QR check-ins need signal at the machine and reach the device at its next contact, so the device must poll often
  while parked (to-do 9). Beacons work anywhere.

## Not done yet

The phone app (Veristart's other way in, over Bluetooth), relay status on the machine page, and the simulator
playing the relay.
