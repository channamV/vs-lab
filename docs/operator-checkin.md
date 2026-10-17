# Operators and QR check-in

Part of Tier 2, Safety & Access Monitoring: know **who** is operating each machine, and whether
they did the pre-start checklist. Works on any phone (iPhone or Android) with no app to install.

## How it works for the operator

1. Scan the **QR sticker** on the machine with the phone camera. The check-in page opens.
2. Enter their **PIN**.
3. Answer the **pre-start checklist**: OK or Not OK for each item, plus optional notes.
4. Tap **Check in**. The phone asks to share its location: tap **Allow**.
5. **Start the engine within 5 minutes.** That engine run now belongs to them.
6. Nothing to do at the end: when the engine stops, they're **checked out automatically**.
   Next time they start the machine (after lunch, the next morning), they scan and check in again.

No check-out needed. (Experience with tap-in/tap-out cards: people don't check out.) A check-out
option is still on the page for anyone who wants it.

A "Not OK" answer doesn't block the check-in. The machine still starts (this is Monitoring, not
Control), and the answer is recorded and flagged for the fleet manager.

## How we confirm the operator is really at the machine

Two automatic checks, both recorded with every check-in and shown as flags:

**1. Location check.** At check-in, the page reads the phone's GPS position and compares it with the
machine's last GPS position from the Freematics device. Both have GPS and cellular, so if they're
close together, the operator was at the machine.
- Within **100 m**, plus the phone's own GPS accuracy (up to 150 m extra): **at machine** ✓
- Further away: flagged **not at machine (2.3 km away)**. This catches check-ins from the truck,
  the site trailer or home using a photo of the QR code.
- Operator declined to share location: flagged **location not shared**.
- Machine has never had a GPS fix: not flagged (not the operator's fault), shown as "Machine has no GPS fix".

**2. Check-in follows the engine.** One check-in covers one engine run:
- Engine starts within **5 minutes** of check-in: the run is linked to that operator ("Started 2 min after").
- Engine doesn't start within 5 minutes: the operator is checked out automatically ("No start").
- Engine stops, or the device stops reporting: the operator is checked out automatically ("engine stopped").
- Engine already running at check-in:
  - another operator had it (shift change on an idling machine): **takeover**, no flag;
  - nobody had it: flagged **engine running before check-in** (the checklist was done after starting).

An engine run that nobody checked in for raises an **unauthorized use** alert after 5 minutes, on
armed Safety & Access Monitoring machines (see [alerts.md](alerts.md)).

Neither check blocks anyone: on Safety & Access Monitoring the machine always starts and the platform
reports. In step 3, these flags can trigger email alerts.

The numbers (100 m, 150 m, 5 minutes) are in `CHECKIN_RULES` in `platform/src/lib/operators.ts`.

## Setting it up (fleet manager)

1. **Add operators:** *Operators* page → name + a 4–8 digit PIN. Each operator needs a different PIN,
   and the PIN alone identifies them. PINs can't be looked up later, only reset (*Edit*).
2. **Approve operators per machine (optional):** machine page → *Approved operators*. If nobody is
   ticked, any active operator can check in. If some are ticked, others can still check in but are
   flagged as **not approved**.
3. **Print the QR sticker:** machine page → *Print QR sticker* → print (Ctrl+P). Stick it where the
   operator sees it before getting in: on the door or by the steps. Use a weatherproof label or laminate it.
   Print it from the live site, not your PC, so the code points to the internet address.

## Where to see the results

- **Fleet page:** *Operator* column shows who is checked in, with flags for checklist issues,
  not-approved operators, not at machine, location not shared, and engine running before check-in.
- **Machine page:** current operator (with *End check-in* if needed) and the check-in history,
  with *At machine* and *Engine* columns. Click "1 not OK" to see which
  items failed and the operator's notes.

## Security notes

- Phone locations are stored with each check-in, for the audit trail only.
- The check-in page is public: anyone with the QR code can open it. It shows only the machine's
  name and who is checked in. Nothing else is visible without the admin password.
- PINs are short, so they're a convenience, not strong security. After 5 wrong PINs on a machine
  within 10 minutes, that machine's page stops accepting PINs for 10 minutes.
- To stop someone checking in, untick *Active* on their operator page. That also checks them out.

## Changing the checklist

The questions are in `platform/src/lib/checklist.ts`. Ask Claude Code to change them. Past
check-ins keep the questions as they were asked at the time.

## Trying it with test data

`npm run demo:seed` adds three demo operators with PINs **1111**, **2222** and **3333**, plus a week
of check-ins for the simulated machines. Open `/checkin/SIM00001` to try the operator's side.
