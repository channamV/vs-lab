# Pre-start checklists

Each company sets up its own pre-start checklists: **Checklists** in the top bar (managers and owners).

## The pieces

- **Answer sets:** the answers operators choose from. Every answer has a label (anything you like) and a
  **meaning**, which decides what happens:

  | Meaning | What happens |
  |---|---|
  | **OK (pass)** | Nothing. |
  | **Minor defect** | Recorded as an issue on the machine and raises a **Repair needed** alert. |
  | **Major defect** | Same as minor, and the operator is asked *"You indicated a major defect. Should we lock out this machine for repair?"* |
  | **Not applicable** | Counts as a pass. |

  Every company starts with two, both editable:
  - **Standard:** OK / Service soon / Lockout / Not applicable
  - **Vehicle inspection:** OK / Minor defect / Major defect / Not applicable (the on-road vehicle log terms)

- **Checklists (templates):** a name, one answer set, **sections** of **questions** (add, reword, reorder,
  remove), and the **final confirmation** the operator ticks before checking in, e.g. *"I have inspected this
  equipment and confirm that it is safe to use."* Change the wording to whatever your jurisdiction requires.
  - Tick **Note on defect** on a question to make the operator describe the problem when they report one.
  - **Copy** an existing checklist to start a new one from it.
- **Default checklist:** used by every machine that doesn't have its own. The original 10 VS Lab questions
  became the default, *Standard pre-start*. Pick another with **Make default**.
- **Per machine:** on a machine's page, *Checklist and issues* → choose its checklist (or the company default).

Editing a checklist or answer set changes the **next** check-in. Past check-ins keep the questions and answers
exactly as they were at the time.

Only managers and owners who see the whole company can change checklists (a manager limited to a division can
still choose which checklist each of their machines uses).

## Photos

Operators can attach up to **3 photos to any question** (the 📷 button opens the phone's camera). In the checklist
editor, each question is one of:

| Type | The operator… |
|---|---|
| **Answer (photo optional)** | answers it; photos are optional |
| **Answer + required photo** | answers it and must take at least one photo |
| **Photo only** | just takes the photo, e.g. "Photo of front", "Photo of left side" (no answer) |
| **Written answer** | types a short answer, e.g. "Odometer reading", "Place of inspection" (required; shown in the machine's check-in history) |

- Photos are shrunk on the phone (to about 0.1–0.2 MB) before they're sent, so a check-in with many photos still
  goes through on a weak signal. A check-in can carry about 4 MB of photos in total.
- They're stored **privately** (Vercel Blob store *vs-lab-photos*, connected to the project). They're only
  visible to signed-in people of the company who can see the machine: thumbnails in the machine's check-in history
  (click "📷 3" on a check-in) and on each issue under *Checklist and issues*; click one to see it full size.
- Each photo has space reserved for a future AI review (e.g. spotting damage the operator didn't report).
- On your own computer, photos are saved in `platform/.data/photos`.

## What the operator sees

The machine's checklist, section by section, with the answer buttons in their colours and a 📷 button on each
question (required photos are marked). For a defect they can add a description (required where the checklist says
so). Then:
- **Major defect** → the lockout question. **Yes** locks the machine out (see below) instead of checking in.
  **No** carries on.
- The **final confirmation** must be ticked to check in (not needed when locking out).

## Issues: defects stack

Every defect becomes an **issue** on the machine (machine page → *Checklist and issues*).
- The same item reported again while its issue is open **stacks**: the issue shows "reported 3 times" and the
  latest note, and **no new alert** is raised.
- Reported as **more severe** than before (minor → major), the issue is escalated and alerts again.
- Managers mark issues **Resolved** (optionally with what was done). A later report opens a new issue.

This is the starting point for a maintenance module like production's.

## Lockout for repair

When an operator locks a machine out:
- their check-in is recorded and ends immediately;
- the machine shows **🔒 Locked out** on Fleet and its page; its QR page says *"Locked out for repair. Do not
  operate"* and nobody can check in;
- a **Repair needed** alert says it was locked out, and an **Equipment Locked** notification goes to anyone
  subscribed.

A manager clears it on the machine page (**Repaired: clear lockout**). On Safety & Access Monitoring the machine
can still physically start; actually preventing the start needs the starter relay of Safety & Access Control.
If an Access-Controlled machine starts with nobody checked in, the usual **Unauthorized use** alert follows.

## Ready-made checklists

**Checklists → Ready-made checklists → Add** copies a regulation-based checklist into the company. It opens for review
and is then an ordinary checklist (edit, copy, make default, or pick it per machine). It isn't made the default.

### NL trip inspection – truck, tractor, trailer (Schedule A)

For Newfoundland and Labrador commercial vehicles: trucks, tractors and trailers over **4,500 kg** registered gross
weight (buses have their own schedule). Source: *Trip Inspection Report Regulations*, NLR 27/12 under the Highway
Traffic Act, Schedule A, which follows National Safety Code Standard 13, Schedule 1. Researched 2026-10-25; the official
text at assembly.nl.ca couldn't be opened from the build environment, so the 23 systems and their defects are taken from
NSC Standard 13 Schedule 1 and confirmed in part against NL extracts. **Check the wording against the current regulation
before a customer relies on it.**

What the rules require, and how vs-lab covers it:

| Requirement | In vs-lab |
|---|---|
| Inspect every system in Schedule A column 1 (unless the vehicle doesn't have it) | 23 questions, numbered as in the schedule; "Not applicable" for systems the vehicle lacks |
| Inspect at least every 24 hours; no driving an uninspected vehicle | Check-in before each start (machine rules); a 24-hour rule isn't enforced separately |
| Report: plate or unit number of each vehicle | Machine's unit # / name; trailers as a written answer |
| Report: carrier's name; date and time | Company name; check-in time |
| Report: place of inspection | Written answer (the phone's location is also recorded when shared) |
| Report: defects found, or that there were none | Minor / Major defect answers, each with a required description |
| Report: inspector's name and signed statement | Operator (PIN) and the confirmation statement |
| Odometer reading | Written answer |
| Minor defect → report to the carrier | Raises "Repair needed" for managers |
| Major defect → vehicle must not be driven | Raises "Repair needed"; the operator is asked whether to lock the machine out. **vs-lab doesn't yet force a lockout on a major defect** |
| Carrier keeps reports and repair records (5 years, per summaries) | Check-ins and resolved issues are kept for the company's retention period (Settings): set it to 5 years for NL carriers |

The confirmation statement says the inspection was done under the NL regulations (Schedule A) and that the driver
won't drive with a major defect.
