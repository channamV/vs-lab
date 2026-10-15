# Operators and QR check-in

Part of Tier 2, Safety & Access Monitoring: know **who** is operating each machine, and whether
they did the pre-start checklist. Works on any phone (iPhone or Android) with no app to install.

## How it works for the operator

1. Scan the **QR sticker** on the machine with the phone camera. The check-in page opens.
2. Enter their **PIN**.
3. Answer the **pre-start checklist**: OK or Not OK for each item, plus optional notes.
4. Tap **Check in**. They stay checked in until they check out, another operator checks in on that
   machine, or they check in on a different machine. A check-in left open for more than 12 hours
   no longer counts.

A "Not OK" answer doesn't block the check-in. The machine still starts (this is Monitoring, not
Control), and the answer is recorded and flagged for the fleet manager.

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

- **Fleet page:** *Operator* column shows who is checked in, with flags for checklist issues or
  not-approved operators.
- **Machine page:** current operator (with *End check-in* if they forgot to check out) and the
  check-in history. Click "1 not OK" to see which items failed and the operator's notes.

## Security notes

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
