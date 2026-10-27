# Privacy (GDPR)

> Canada (PIPEDA, Quebec) and how vs-lab compares with Veristart's own privacy policy: [privacy-canada.md](privacy-canada.md).
> **vs-lab is not yet compliant with that policy**: see the "Must fix" items there.

What VS Lab does to handle personal data properly, so it can be used by customers in Europe (and is good practice
everywhere). The people whose data we hold are mainly **operators**: their name, PIN, when they ran which machine,
checklist answers, notes, photos, and (if they allow it) their phone's location at check-in. Portal users' email
addresses are personal data too.

In GDPR terms, **the customer is the "controller"** (they decide why operator data is collected) and
**Veristart is the "processor"** (we run the system for them). That needs a data processing agreement (DPA) with
each customer, a list of our sub-processors (Vercel, Neon, Resend), and, for EU customers, EU hosting. Those are
contract and hosting steps, outside this code; see *Still to do* below.

## What's built

### 1. Retention: data is deleted when it's no longer needed

Each organization chooses how long data is kept (**Settings**, owners only). Every night a clean-up deletes anything older:

| Data | Default | Allowed |
|---|---|---|
| Operators' phone location at check-in | 90 days | 1 day – 10 years |
| Checklist photos | 1 year | 30 days – 10 years |
| GPS track, device data, connectivity incidents | 2 years | 30 days – 10 years |
| Check-ins, checklist answers, alerts, fuel log, safety log | 3 years | 90 days – 10 years |
| Notification history (who was emailed what) | 1 year | 30 days – 10 years |
| Operators' training records and certificate copies | Until a manager deletes them or the operator is erased | — |
| Maintenance items (the machine's service record) and meter readings | Kept (about the machine) | — |
| Operator app sign-ins (phone name, last used) and sign-in codes | Until 90 days unused; codes a day | — |

Details:
- When the phone location goes, the check-in keeps the *result* (at the machine / not at the machine) and the distance.
- A check-in that's still open is never deleted. Engine hours stay (they're about the machine).
- Maintenance items are the machine's service history and are kept (`docs/maintenance.md`). When a check-in is deleted, its
  reports on maintenance items keep the answer and note but lose the link to the operator and the photos. Erasing an
  operator removes their name from maintenance items and reports.
- Data from devices that weren't on any machine is deleted after 2 years.
- Expired sign-ins, used sign-in links and wrong-PIN records are tidied up too.
- Some customers must keep inspection records for a minimum time (e.g. a regulation). They set the check-in period to match.

The clean-up is `/api/jobs/retention`, run by Vercel Cron once a night (03:17 UTC, in `platform/vercel.json`; a
daily schedule works on the free plan). It needs `CRON_SECRET` in Vercel's environment variables, like the tamper
watchdog; until that's set, it does nothing. On your own computer: `npm run retention` (in `platform/`).

### 2. An operator's data: download and erase

On an operator's page (**Operators → the operator**), managers and owners who see the whole company have
*Operator's data (privacy requests)*:

- **Download their data (JSON)**: everything stored about them: details (including email and mobile number),
  approved machines, training records, every check-in with answers, notes, phone location and photo links, related
  alerts and notifications. This answers a request to
  see their data. (The PIN is stored only as a one-way code, so it can't be included.)
- **Erase their data**: for someone who asks to be forgotten. Type ERASE to confirm. It:
  - replaces their name with *Former operator #12* and removes their employee number, email, mobile number and PIN (nobody can check in as them again; the PIN is free for someone else);
  - deletes their training records and the stored certificate copies;
  - removes their machine approvals, the phone location on all their check-ins, and their checklist photos;
  - replaces their name wherever it was written into check-in notes, defect notes, alerts, lockout reasons and notifications.

  The check-ins themselves, checklist answers, defects and engine hours **stay** on the machines' records under
  *Former operator #12*: the company may need them for safety and inspection records, and they no longer identify
  the person. It can't be undone. If the person comes back, add them as a new operator.

Emails already sent can't be recalled; they're outside the system.

### 3. Telling operators (privacy notice)

The check-in page has a **Privacy** section: what's recorded and why, how long it's kept (from the company's
settings), that Veristart runs the system, and who to contact. The contact is the **privacy contact** on the
Settings page (e.g. `privacy@company.com`); without one it says "ask your supervisor".

Sharing the phone's location is already optional: the operator's phone asks, and check-in works without it.

### 4. Access log

**Settings → Access log** shows the customer:
- each time **Veristart staff** opened their organization (platform admins switching to it, for support), and
- each operator data download and erasure, and who did it.

## Still to do (outside the code)

- **EU hosting** when the first EU customer is close: a second copy of VS Lab in Frankfurt (Vercel `fra1`, Neon
  Frankfurt, a Blob store in Frankfurt, Resend's EU region), so EU customers' data stays in the EU. Staff would still
  manage both from one place: see the multi-region plan in the conversation of 2026-10-20 (summary: pick North America
  or EU when creating an organization; the org switcher then opens the right site).
- **Paperwork:** a DPA template, a sub-processor list, a short privacy policy, a record of processing, and a
  plan for reporting a data breach within 72 hours. Use a template from a privacy lawyer; the system's side is above.
