# Training and certifications

Keep each operator's training records, see what's expiring, and optionally let training decide who can use which
machines. Optional per company: nothing changes for a company until a manager turns a certification on.

## Where things are

- **Training** (menu → Safety): everyone's certifications with their status, a CSV download, the list of
  certifications, and machine categories.
- **Operators → an operator → Training & certifications**: their records, the certificate copies, and **Add training
  record**.
- **Machines → Edit**: each machine's **Category** (which certifications cover it).

Who can do what:
- **Managers and owners** add, edit and delete training records. A manager's entry needs no further approval.
  (Operators adding their own, with a manager approving, could come later.)
- **Managers and owners with access to the whole company** set up certifications and categories (like checklists).
- **Viewers** can see everything but change nothing.

## Machine categories

Certifications cover machines by **category** (e.g. "Excavator"), so a new excavator is covered automatically.
Each company starts with common construction categories:

Excavator, Mini excavator, Wheel loader, Backhoe loader, Skid steer / compact track loader, Dozer, Motor grader,
Compactor / roller, Articulated / off-highway truck, Dump truck (on-road), Telehandler, Forklift, Aerial work
platform, Mobile crane, Pickup / light vehicle, Other equipment.

The first time, machines get a category from their **Type** where it's clear (e.g. "Mini Ex" → Mini excavator).
Check them on each machine's Edit page. Companies can add their own categories, and delete ones they don't use.

## Certifications

Each company starts with a list of common ones, **switched off**:

| Certification | Usual renewal | Covers |
|---|---|---|
| Excavator operator | 3 years | Excavator, Mini excavator |
| Loader operator | 3 years | Wheel loader, Backhoe loader |
| Skid steer / compact loader operator | 3 years | Skid steer / compact track loader |
| Dozer, Motor grader, Compactor / roller, Haul truck operator | 3 years | their category |
| Telehandler operator (CSA B335) | 3 years | Telehandler |
| Forklift operator (CSA B335) | 3 years | Forklift |
| Aerial work platform (CSA B354) | 3 years | Aerial work platform |
| Mobile crane operator | 3 years (set to your province's) | Mobile crane |
| Commercial driver's licence (Class 1/3, AZ/DZ) | 5 years (use the licence's date) | Dump truck (on-road) |
| Working at Heights | 3 years (Ontario) | — (record only) |
| WHMIS | 1 year | — |
| First Aid / CPR | 3 years | — |
| Ground disturbance | 3 years | — |
| Traffic control person | 3 years | — |

Periods are common practice, not legal advice: set them to match your province and company policy.

To use one: **Training → Not in use → Set up** (or **Add certification** for your own). For each:

- **Valid for**: months until it expires (blank = never). Fills in the expiry date when a record is added.
- **Grace period**: days after expiry it still counts (e.g. 14 days while the renewal is booked).
- **Remind**: days before expiry to send reminders (default 60, 30 and 7).
- **Machines it covers**: categories and/or specific machines.
- **Two questions, both must be answered** (no default):
  - **Auto-grant access?** Yes: a valid record lets the operator check in on the machines it covers, without being
    approved machine by machine. Their existing approvals still work too.
  - **Required to operate?** Yes: without a valid record (or within the grace period), the operator can't check in
    on the machines it covers, even if approved. The phone shows "You need valid training to operate this machine.
    Ask your supervisor about: Excavator operator."
- **In use**: unticked keeps the records but grants nothing, blocks nothing and sends no reminders.

How access works:
- It's worked out at every check-in from the dates, so nothing has to be switched on or off: when a record expires,
  the next check-in is affected; when a renewal is added, the operator can check in straight away.
- An operator already checked in is never stopped mid-shift.
- On machines without check-ins (GPS & Telematics, or Unlocked mode) training is recorded but doesn't block anyone.

## Training records

**Add training record** on the operator's page: the certification, the date it was issued, the expiry (filled in
from the certification, change it to the date on the card), the provider, the card number, notes, and a photo or PDF
of the certificate (photos are shrunk on the phone first; up to 3.8 MB).

Statuses: **Valid**, **Expiring soon** (within the reminder window), **Expired (grace period)**, **Expired**. When
a certification is renewed, add a new record: the newest one counts, and older ones show as "Replaced by a newer
record". Certificate copies are private: only signed-in users of the same company can open them.

## Reminders

Every 5 minutes the watchdog checks expiry dates. At each reminder day and on expiry (each once):
- a **Training Expiring** or **Training Expired** notification. Subscribe to them on the **Notifications** page.
  Subscriptions limited to some machines or divisions don't get them (they're about a person, not a machine).
- an email to the operator, if they have an **email** on their page.

Operators also have a **mobile number** field; text-message reminders need an SMS service set up first (not yet).

## Privacy

Training records, certificate copies and operators' email and mobile numbers are personal data:
- included in **Download their data** and removed by **Erase their data** ([privacy.md](privacy.md));
- mentioned in the check-in privacy notice;
- kept until a manager deletes them or the operator is erased (no automatic deletion: companies need them while the
  person works there).

## For developers

- Code: `platform/src/lib/training.ts` (tested in `training.test.ts`), browser-safe dates and status in
  `training-status.ts`. Pages: `src/app/(admin)/training/`. Check-in: `checkIn` in `src/lib/operators.ts` calls
  `trainingAccess`.
- Tables: `machine_categories`, `certification_types`, `training_records`; `machines.category_id`,
  `operators.email/phone`.
- Reminders: `sendTrainingReminders` in `runWatchdog` (and `npm run watchdog`).
