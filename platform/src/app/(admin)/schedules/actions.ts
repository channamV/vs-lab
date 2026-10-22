"use server";

import { after } from "next/server";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { processEvents } from "@/lib/notifications";
import { createSchedule, deleteSchedule, ScheduleError, setScheduleStatus, updateSchedule } from "@/lib/schedules";
import { requireAuth } from "@/lib/session";

/**
 * Schedules. Anyone signed in may call these, but only for actions they could do live (operating modes and
 * operator approvals: managers and owners, within their divisions); src/lib/schedules.ts checks that.
 */

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable();
const time = z.string().regex(/^\d{2}:\d{2}$/).nullable();
const Spec = z.object({
  name: z.string().max(200),
  status: z.enum(["active", "paused"]),
  action: z.enum(["machine_mode", "operator_access"]),
  mode: z.enum(["access_controlled", "unlocked", "locked"]).nullable(),
  machineIds: z.array(z.number().int().positive()).max(500),
  operatorIds: z.array(z.number().int().positive()).max(500),
  recurrence: z.enum(["once", "weekly", "override"]),
  timezone: z.string().max(60),
  startDate: date,
  startTime: time,
  endDate: date,
  endTime: time,
  noEnd: z.boolean(),
  weekdays: z.array(z.number().int().min(0).max(6)).max(7),
  allDay: z.boolean(),
  effectiveFrom: date,
  effectiveUntil: date,
  endBehavior: z.enum(["revert", "set_mode"]),
  endMode: z.enum(["access_controlled", "unlocked", "locked"]).nullable(),
  remindBeforeExpiry: z.boolean(),
});

export type ScheduleFormState = { error: string | null; version: number };

/** Notifications for mode changes the save applied straight away (a window already running). */
const deliverLater = () => after(() => processEvents(getDb(), {}));

export async function saveScheduleAction(prev: ScheduleFormState, formData: FormData): Promise<ScheduleFormState> {
  const auth = await requireAuth();
  const parsed = Spec.safeParse(JSON.parse(String(formData.get("payload") ?? "null")));
  if (!parsed.success) return { error: "Check the schedule's details.", version: prev.version + 1 };
  const id = String(formData.get("id") ?? "");
  try {
    if (id) await updateSchedule(getDb(), auth, z.coerce.number().int().positive().parse(id), parsed.data);
    else await createSchedule(getDb(), auth, parsed.data);
  } catch (err) {
    if (err instanceof ScheduleError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  deliverLater();
  redirect("/schedules");
}

export async function setScheduleStatusAction(formData: FormData) {
  const auth = await requireAuth();
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const status = z.enum(["active", "paused"]).parse(formData.get("status"));
  await setScheduleStatus(getDb(), auth, id, status);
  deliverLater();
  refresh();
}

export async function deleteScheduleAction(formData: FormData) {
  const auth = await requireAuth();
  await deleteSchedule(getDb(), auth, z.coerce.number().int().positive().parse(formData.get("id")));
  deliverLater();
  refresh();
}
