import type { CheckinFailure } from "@/lib/operators";

/** What operators are told when a check-in is refused (QR page and operator app). */
export const CHECKIN_MESSAGES: Record<CheckinFailure, string> = {
  "unknown-machine": "This machine isn't set up for check-in. Tell your supervisor.",
  locked: "Too many wrong PINs on this machine. Wait 10 minutes and try again.",
  "bad-pin": "PIN not recognized.",
  incomplete: "Answer every checklist item.",
  "note-required": "Describe the problem for each item marked as a defect.",
  "photo-required": "Take the required photos.",
  "photo-invalid": "A photo couldn't be used (too large, or not a picture). Remove it and take it again.",
  "not-confirmed": "Tick the confirmation at the end of the checklist.",
  "checklist-needed": "You haven't done today's checklist on this machine yet. Complete the checklist to check in.",
  "machine-locked-out": "This machine is locked out for repair. Don't operate it: a manager has to clear it first.",
  "machine-locked": "This machine is Locked by a manager. Don't operate it: ask your supervisor.",
  "training-required": "You need valid training to operate this machine. Ask your supervisor about:",
  "not-checked-in": "Nobody is checked in on this machine.",
  "meter-invalid": "Enter the hour meter / odometer reading as a number, e.g. 1234.5.",
};
