# Machines and devices

VS Lab keeps two separate things:

| | What it is | Who manages it |
|---|---|---|
| **Machine** | The customer's equipment: an excavator, a loader. Has a name, unit / fleet #, type, make, model, year, serial # / VIN and service level. | The customer (managers and owners): **Fleet → Add machine**, and the *Machine details* box on its page |
| **Device** | The tracking hardware (Freematics) bolted into a machine. Known by the ID it reports with. | Veristart staff, on the **Platform** page |

**The data belongs to the machine.** Position history, engine hours, check-ins, alerts, the approved-operator
list and the QR sticker all stay with the machine when its device fails or is replaced. A device only
supplies data while it's paired with a machine.

## Unit numbers

The unit / fleet # is how a machine is shown everywhere ("Unit 14 · CAT 320 Excavator"), and the fleet
list is sorted by it. It's optional, and must be unique within the organization.

## Device life cycle (Veristart staff)

1. **New device reports for the first time** → it appears on **Platform** in *Veristart stock*. Its data is
   stored but belongs to no machine and no customer sees it.
2. **Pair** it with a customer's machine (from the Platform page, or the *Tracking device* box on the
   machine's page). The device moves into that customer's stock; from now on its data is the machine's.
3. **Device fails or is swapped** → **Unpair**. The device stays in the customer's stock as a *spare*,
   ready to pair with another of their machines. The machine keeps its history; its engine shows
   *Unknown* until a new device reports. Then pair the replacement with the same machine.
4. **Device comes back to Veristart** → on Platform, **Move** it to *Veristart stock*.

Rules the system enforces: one device per machine, one machine per device (unpair first), and a device
in one customer's stock can't be paired with another customer's machine.

Customers see which device is on each machine and the earlier ones, but can't pair or unpair.

Each device has a diagnostics page for staff (click its ID on Platform): last report, battery, signal,
VIN read over OBD, the machines it has been on, and its latest raw data.

## QR stickers

The sticker on a machine points at the machine's own code (`/checkin/<code>`), not the device, so it
keeps working after a device swap. New machines get a random 8-character code. Machines that existed
before this change kept their old device ID as the code, so stickers already printed still work.

## Bench tests

Reports from a device that isn't paired (on the bench, in stock) are stored for diagnostics only. They
never create engine hours, check-ins or alerts for any machine.
