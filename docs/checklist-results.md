# Checklist results

Where to find the pre-start checklists operators completed, and how to download or print them
(Craig, 2026-10-26; modelled on Veristart production's Prestart Checklist list, detail and bulk export).

## Where

**Safety → Checklist results** (`/checklists/results`). Everyone signed in can see it (owners, managers, viewers);
people limited to some divisions only see those divisions' machines. Also linked from the Checklists page.

## Filters

All filters are in the page address, so a filtered view can be bookmarked or sent to a colleague.

| Filter | Notes |
|---|---|
| Dates | Today, last 7/14/30/90 days, this/last month, or custom dates (up to a year back). Days are in the company time zone. Default: last 30 days. |
| Machine, division, operator | Division only shows if the company uses divisions. |
| Result | All results / With defects (minor or major) / Locked out (operator locked the machine out for repair) / All OK. |
| Include "done earlier today" | Check-ins with no checklist because today's checklist on that machine was already done (the checklist's "How often" setting). Off by default. |

The list is newest first, 50 per page.

## One checklist

Click a date to open it: answers by section, defects highlighted (⚠️ with the answer in amber/red), notes, written
answers (e.g. odometer), photos (click to enlarge), the confirmation statement the operator agreed to, whether the
operator was at the machine (phone location) and approved. **Print / Save as PDF** opens the browser's print
dialog; choose "Save as PDF" as the printer for a file.

## Downloads (same filter as the list)

- **Download CSV**: one row per answer (Date, Time, Unit, Machine, Operator, Checklist, Result, Section, Question,
  Answer, Defect, Note, Photos, At machine, Check-in ID), plus a "General notes" row when the operator wrote one and a
  single row for each "done earlier today" check-in. Opens in Excel; filter or pivot it there. Up to 5,000 checklists.
- **Print / PDF report**: every matching checklist in one document, one per printed page, with a summary line at the
  top. Up to the newest 200; narrow the filter for more.

## Code

`platform/src/lib/checklist-results.ts` (filters, queries, CSV; tested), `src/lib/data.ts` (Checklist results section),
pages in `src/app/(admin)/checklists/results/` (`ResultView.tsx` is shared by the detail page and the report;
`export/route.ts` is the CSV). Limits in `RESULT_RULES`.
