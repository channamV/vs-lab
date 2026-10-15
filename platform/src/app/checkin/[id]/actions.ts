"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { CHECKLIST } from "@/lib/checklist";
import { checkIn, checkOut, type CheckinFailure } from "@/lib/operators";

/**
 * PUBLIC actions: operators use them without signing in. They only accept a machine ID, a PIN and
 * checklist answers, and rely on the PIN check and rate limit in src/lib/operators.ts.
 */

export type CheckinFormState =
  | { status: "idle" }
  /** `values` refills the form after an error, so the operator doesn't redo the checklist. */
  | { status: "error"; message: string; attempt: number; values?: { answers: Record<string, string>; notes: string } }
  | { status: "checked-in"; operatorName: string; authorized: boolean; failedItems: string[] };

const MESSAGES: Record<CheckinFailure, string> = {
  "unknown-machine": "This machine isn't set up for check-in. Tell your supervisor.",
  locked: "Too many wrong PINs on this machine. Wait 10 minutes and try again.",
  "bad-pin": "PIN not recognized.",
  incomplete: "Answer every checklist item (OK or Not OK).",
  "not-checked-in": "Nobody is checked in on this machine.",
};

const Base = z.object({ deviceId: z.string().min(1).max(32), pin: z.string().trim().max(16) });

const nextAttempt = (prev: CheckinFormState) => (prev.status === "error" ? prev.attempt + 1 : 1);

export async function checkInAction(prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const { deviceId, pin } = Base.parse({ deviceId: formData.get("deviceId"), pin: formData.get("pin") ?? "" });
  const answers = Object.fromEntries(
    CHECKLIST.map((item) => {
      const value = formData.get(`item:${item.id}`);
      return [item.id, value === "ok" ? true : value === "no" ? false : undefined];
    }),
  );
  const notes = String(formData.get("notes") ?? "").slice(0, 1000);

  const result = await checkIn(getDb(), { deviceId, pin, answers, notes });
  if (!result.ok) {
    const submitted = Object.fromEntries(CHECKLIST.map((item) => [item.id, String(formData.get(`item:${item.id}`) ?? "")]));
    return { status: "error", message: MESSAGES[result.reason], attempt: nextAttempt(prev), values: { answers: submitted, notes } };
  }
  refresh();
  return { status: "checked-in", operatorName: result.operatorName, authorized: result.authorized, failedItems: result.failedItems };
}

export async function checkOutAction(prev: CheckinFormState, formData: FormData): Promise<CheckinFormState> {
  const { deviceId, pin } = Base.parse({ deviceId: formData.get("deviceId"), pin: formData.get("pin") ?? "" });
  const result = await checkOut(getDb(), { deviceId, pin });
  if (!result.ok) return { status: "error", message: MESSAGES[result.reason], attempt: nextAttempt(prev) };
  // Reload the page with a confirmation (the check-out box disappears once nobody is checked in).
  redirect(`/checkin/${encodeURIComponent(deviceId)}?checkedOut=1`);
}
