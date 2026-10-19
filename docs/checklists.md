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

## What the operator sees

The machine's checklist, section by section, with the answer buttons in their colours. For a defect they can add
a description (required where the checklist says so). Then:
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
If an armed machine starts with nobody checked in, the usual **Unauthorized use** alert follows.
