"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { afterCheckin } from "@/lib/alert-jobs";
import type { PhotoFile } from "@/lib/photos";
import { placeNearMachine } from "@/lib/checkin-page";
import { CHECKIN_RULES, checkIn, checkOut, type CheckinFailure, type LocationCheck, type PhoneLocation } from "@/lib/operators";

/**
 * PUBLIC actions: operators use them without signing in. They only accept a machine's QR code, a PIN and
 * checklist answers, and rely on the PIN check and rate limit in src/lib/operators.ts.
 */

export type CheckinFormState =
  | { status: "idle" }
  /** The form keeps its answers itself (React state), so an error doesn't make the operator start over. */
  | { status: "error"; message: string; attempt: number }
  | { status: "locked-out"; failedItems: string[] }
  | {
      status: "checked-in";
      operatorName: string;
      authorized: boolean;
      failedItems: string[];
      location: LocationCheck;
      distanceM: number | null;
      engineRunning: boolean;
      startWindowMinutes: number;
    };

const MESSAGES: Record<CheckinFailure, string> = {
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

const Base = z.object({ machineCode: z.string().min(1).max(32), pin: z.string().trim().max(16) });

/** The phone's position, filled in by the page just before submitting (empty if the operator declined). */
const Location = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  accuracyM: z.coerce.number().min(0).max(100_000),
});

function phoneLocation(formData: FormData): PhoneLocation | null {
  if (!formData.get("phoneLat") || !formData.get("phoneLng")) return null;
  const parsed = Location.safeParse({
    lat: formData.get("phoneLat"),
    lng: formData.get("phoneLng"),
    accuracyM: formData.get("phoneAccuracy") || 0,
  });
  return parsed.success ? parsed.data : null;
}

const nextAttempt = (prev: CheckinFormState) => (prev.status === "error" ? prev.attempt + 1 : 1);

export async function checkInAction(prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const { machineCode, pin } = Base.parse({ machineCode: formData.get("machineCode"), pin: formData.get("pin") ?? "" });
  // Answers and per-question notes arrive as item:<question id> and note:<question id>.
  const answers: Record<string, string> = {};
  const answerNotes: Record<string, string> = {};
  // Photos arrive as photo:<question id> files, already shrunk by the phone (CheckinForms.tsx).
  const photos: PhotoFile[] = [];
  for (const [key, value] of formData.entries()) {
    if (key.startsWith("photo:") && typeof value !== "string" && photos.length < 40) {
      photos.push({ questionId: key.slice(6, 46), data: new Uint8Array(await value.arrayBuffer()), contentType: value.type });
      continue;
    }
    if (typeof value !== "string" || value.length > 500) continue;
    if (key.startsWith("item:")) answers[key.slice(5, 45)] = value.slice(0, 40);
    if (key.startsWith("note:")) answerNotes[key.slice(5, 45)] = value;
  }
  const result = await checkIn(getDb(), {
    machineCode,
    pin,
    answers,
    answerNotes,
    notes: String(formData.get("notes") ?? "").slice(0, 1000),
    confirmed: formData.get("confirmed") === "on",
    lockout: formData.get("lockout") === "yes",
    skipChecklist: formData.get("skipChecklist") === "on",
    photos,
    phoneLocation: phoneLocation(formData),
    meterReading: String(formData.get("meterReading") ?? "").slice(0, 20),
  });
  if (!result.ok) {
    const list = result.questions?.slice(0, 3).join("; ");
    const which = !list ? "" : result.reason === "training-required" ? ` ${list}.` : ` (${list})`;
    return { status: "error", message: MESSAGES[result.reason] + which, attempt: nextAttempt(prev) };
  }
  afterCheckin(result.checkinId);
  // No page refresh after a lockout: the page would swap the confirmation for the "locked out" notice.
  if (result.lockedOut) return { status: "locked-out", failedItems: result.failedItems };
  refresh();
  return {
    status: "checked-in",
    operatorName: result.operatorName,
    authorized: result.authorized,
    failedItems: result.failedItems,
    location: result.location,
    distanceM: result.distanceM,
    engineRunning: result.engineRunning,
    startWindowMinutes: CHECKIN_RULES.engineStartWindowMinutes,
  };
}

export async function checkOutAction(prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const { machineCode, pin } = Base.parse({ machineCode: formData.get("machineCode"), pin: formData.get("pin") ?? "" });
  const result = await checkOut(getDb(), { machineCode, pin });
  if (!result.ok) return { status: "error", message: MESSAGES[result.reason], attempt: nextAttempt(prev) };
  // Reload the page with a confirmation (the check-out box disappears once nobody is checked in).
  redirect(`/checkin/${encodeURIComponent(machineCode)}?checkedOut=1`);
}

/**
 * The town and province where the operator's phone is, to start a "Place of inspection" answer (they can change
 * it). Only near the machine, so the page can't be used to look up places anywhere.
 */
export async function placeNameAction(machineCode: string, lat: number, lng: number): Promise<string | null> {
  const parsed = z.object({ code: z.string().min(1).max(32), lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }).safeParse({ code: machineCode, lat, lng });
  if (!parsed.success) return null;
  return placeNearMachine(getDb(), parsed.data.code, parsed.data.lat, parsed.data.lng);
}
