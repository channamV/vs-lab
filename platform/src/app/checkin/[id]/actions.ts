"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { afterCheckin } from "@/lib/alert-jobs";
import { CHECKLIST } from "@/lib/checklist";
import { CHECKIN_RULES, checkIn, checkOut, type CheckinFailure, type LocationCheck, type PhoneLocation } from "@/lib/operators";

/**
 * PUBLIC actions: operators use them without signing in. They only accept a machine's QR code, a PIN and
 * checklist answers, and rely on the PIN check and rate limit in src/lib/operators.ts.
 */

export type CheckinFormState =
  | { status: "idle" }
  /** `values` refills the form after an error, so the operator doesn't redo the checklist. */
  | { status: "error"; message: string; attempt: number; values?: { answers: Record<string, string>; notes: string } }
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
  incomplete: "Answer every checklist item (OK or Not OK).",
  "not-checked-in": "Nobody is checked in on this machine.",
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
  const answers = Object.fromEntries(
    CHECKLIST.map((item) => {
      const value = formData.get(`item:${item.id}`);
      return [item.id, value === "ok" ? true : value === "no" ? false : undefined];
    }),
  );
  const notes = String(formData.get("notes") ?? "").slice(0, 1000);

  const result = await checkIn(getDb(), { machineCode, pin, answers, notes, phoneLocation: phoneLocation(formData) });
  if (!result.ok) {
    const submitted = Object.fromEntries(CHECKLIST.map((item) => [item.id, String(formData.get(`item:${item.id}`) ?? "")]));
    return { status: "error", message: MESSAGES[result.reason], attempt: nextAttempt(prev), values: { answers: submitted, notes } };
  }
  afterCheckin(result.checkinId);
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
