/**
 * How often a checklist is needed (Craig, 2026-10-25; docs/checklists.md). Browser-safe: the editor shows these.
 * "Today" is the company's time zone. An operator can always do the checklist anyway.
 */
export const CHECKLIST_FREQUENCIES = {
  every_checkin: {
    label: "Before every start",
    help: "Every check-in needs the checklist.",
  },
  operator_daily: {
    label: "Once a day per operator",
    help: "Each operator does it once a day on each machine. A restart later the same day doesn't need another; a new operator (shift change) does their own.",
  },
  machine_daily: {
    label: "Once a day per machine",
    help: "The first checklist of the day on the machine covers everyone who uses it that day.",
  },
} as const;

export type ChecklistFrequency = keyof typeof CHECKLIST_FREQUENCIES;

export const isChecklistFrequency = (v: unknown): v is ChecklistFrequency => typeof v === "string" && v in CHECKLIST_FREQUENCIES;
