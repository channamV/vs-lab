import type { Checklist } from "./types";

/**
 * The checklist form's rules (pure, tested): what's missing before it can be sent, and the fields to send. The same
 * fields as the vs-lab QR page (item:<question>, note:<question>, photo:<question>, …), so the server checks them the
 * same way.
 */

export type PhotoRef = { uri: string; name: string; type: string };

export type FormState = {
  answers: Record<string, string>;
  notes: Record<string, string>;
  photos: Record<string, PhotoRef[]>;
  generalNotes: string;
  meter: string;
  lockout: "yes" | "no" | null;
  confirmed: boolean;
  /** Today's checklist is already done (how-often rules); the server checks. */
  skip: boolean;
};

export const emptyForm = (c: Checklist["checklist"], place: string | null): FormState => ({
  answers: {},
  notes: Object.fromEntries(c.placeQuestionIds.map((id) => [id, place ?? ""])),
  photos: {},
  generalNotes: "",
  meter: c.meter.value !== null ? String(c.meter.value) : "",
  lockout: null,
  confirmed: false,
  skip: (c.frequency === "machine_daily" || c.frequency === "operator_daily") && c.doneTodayAt !== null,
});

export const canSkip = (c: Checklist["checklist"]) => c.frequency === "machine_daily" || c.frequency === "operator_daily";

export function severityOf(c: Checklist["checklist"], key: string | undefined) {
  return c.options.find((o) => o.key === key)?.severity;
}

/** A major defect was reported: the operator must say whether to lock the machine out. */
export const hasMajor = (c: Checklist["checklist"], f: FormState) =>
  c.sections.some((s) => s.questions.some((q) => severityOf(c, f.answers[q.id]) === "major"));

export const lockingOut = (c: Checklist["checklist"], f: FormState) => !f.skip && hasMajor(c, f) && f.lockout === "yes";

/** What still needs doing, in the operator's words (empty = ready to send). */
export function missing(c: Checklist["checklist"], f: FormState): string[] {
  const out: string[] = [];
  if (f.skip) return out;
  const meter = f.meter.replace(/[\s,]/g, "");
  if (!meter || !Number.isFinite(Number(meter)) || Number(meter) < 0) out.push(`the ${c.meter.kind === "km" ? "odometer" : "hour meter"} reading`);
  for (const s of c.sections) {
    for (const q of s.questions) {
      const photos = f.photos[q.id]?.length ?? 0;
      if (q.textOnly) {
        if (!f.notes[q.id]?.trim()) out.push(q.text);
      } else if (q.photoOnly) {
        if (c.photosEnabled && !photos) out.push(`photo: ${q.text}`);
        continue;
      } else {
        const sev = severityOf(c, f.answers[q.id]);
        if (!sev) out.push(q.text);
        else if ((sev === "minor" || sev === "major") && q.noteRequired && !f.notes[q.id]?.trim()) out.push(`describe the problem: ${q.text}`);
      }
      if (c.photosEnabled && q.photoRequired && !photos) out.push(`photo: ${q.text}`);
    }
  }
  if (hasMajor(c, f) && f.lockout === null) out.push("whether to lock the machine out");
  if (!lockingOut(c, f) && !f.confirmed) out.push("the confirmation at the end");
  return out;
}

/** The fields to send (text only; photos are added from `photoFields`). */
export function formFields(c: Checklist["checklist"], f: FormState, phone: { lat: number; lng: number; accuracy: number } | null): [string, string][] {
  const out: [string, string][] = [];
  if (f.skip) out.push(["skipChecklist", "on"]);
  else {
    for (const s of c.sections) {
      for (const q of s.questions) {
        if (q.textOnly) {
          out.push([`note:${q.id}`, (f.notes[q.id] ?? "").trim()]);
          continue;
        }
        if (q.photoOnly) continue;
        const key = f.answers[q.id];
        if (key) out.push([`item:${q.id}`, key]);
        const sev = severityOf(c, key);
        if ((sev === "minor" || sev === "major") && f.notes[q.id]?.trim()) out.push([`note:${q.id}`, f.notes[q.id].trim()]);
      }
    }
    out.push(["meterReading", f.meter.trim()]);
    if (hasMajor(c, f) && f.lockout) out.push(["lockout", f.lockout]);
    if (!lockingOut(c, f) && f.confirmed) out.push(["confirmed", "on"]);
  }
  if (f.generalNotes.trim()) out.push(["notes", f.generalNotes.trim()]);
  if (phone) out.push(["phoneLat", String(phone.lat)], ["phoneLng", String(phone.lng)], ["phoneAccuracy", String(Math.round(phone.accuracy))]);
  return out;
}

/** Photo fields to send (none when the checklist is skipped). */
export const photoFields = (f: FormState) =>
  f.skip ? [] : Object.entries(f.photos).flatMap(([questionId, list]) => list.map((p) => ({ field: `photo:${questionId}`, ...p })));
