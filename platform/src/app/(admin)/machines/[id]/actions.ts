"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/lib/db";
import { endCheckin, setMachineOperators } from "@/lib/operators";
import { assertCheckinInScope, assertMachineInScope } from "@/lib/divisions";
import { appTimeZone, zonedTime } from "@/lib/telemetry/engine";
import { durationEnd, ModeError, setMode, setOfflineFallback } from "@/lib/modes";
import { recordEvent } from "@/lib/notifications";
import { afterEvents } from "@/lib/alert-jobs";
import { clearLockout, resolveIssue, setMachineTemplate } from "@/lib/checklists";

const AllowedOperators = z.object({
  id: z.coerce.number().int().positive(),
  operatorIds: z.array(z.coerce.number().int().positive()),
});

export async function setAllowedOperators(formData: FormData) {
  const auth = await requireAuth("manager");
  const input = AllowedOperators.parse({ id: formData.get("id"), operatorIds: formData.getAll("operator") });
  await assertMachineInScope(getDb(), auth, input.id);
  const { added, removed } = await setMachineOperators(getDb(), auth.organizationId, input.id, input.operatorIds);
  const event = (type: "operator_assigned" | "operator_revoked", operatorId: number) =>
    recordEvent(getDb(), { organizationId: auth.organizationId, machineId: input.id, type, operatorId, detail: `Changed by ${auth.email}` });
  afterEvents(
    await Promise.all([...added.map((id) => event("operator_assigned", id)), ...removed.map((id) => event("operator_revoked", id))]),
  );
  refresh();
}

export async function endCheckinAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const checkinId = z.coerce.number().int().positive().parse(formData.get("checkinId"));
  await assertCheckinInScope(getDb(), auth, checkinId);
  await endCheckin(getDb(), auth.organizationId, checkinId);
  refresh();
}

export type ModeFormState = { error: string | null; version: number };

/** Change the operating mode, now or for a while (managers). */
export async function setModeAction(prev: ModeFormState, formData: FormData): Promise<ModeFormState> {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const duration = z.enum(["indefinite", "1h", "4h", "8h", "morning", "until"]).parse(formData.get("duration") ?? "indefinite");
  await assertMachineInScope(getDb(), auth, id);
  const fail = (error: string) => ({ error, version: prev.version + 1 });
  try {
    const raw = String(formData.get("until") ?? "");
    // datetime-local is the company's wall-clock time.
    const until = duration === "until" ? (raw ? zonedTime(raw, appTimeZone()) : null) : null;
    const event = await setMode(
      getDb(),
      auth.organizationId,
      id,
      { mode: String(formData.get("mode") ?? ""), until: durationEnd(duration, new Date(), until), reason: String(formData.get("reason") ?? "") },
      auth.email,
    );
    afterEvents([event]);
  } catch (err) {
    if (err instanceof ModeError) return fail(err.message);
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

/** What a relay machine does when it has been offline for a while (managers). */
export async function setOfflineFallbackAction(prev: ModeFormState, formData: FormData): Promise<ModeFormState> {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  await assertMachineInScope(getDb(), auth, id);
  const raw = String(formData.get("offlineMode") ?? "");
  try {
    await setOfflineFallback(getDb(), auth.organizationId, id, raw || null, Number(formData.get("offlineAfterHours")), auth.email);
  } catch (err) {
    if (err instanceof ModeError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

/** Which pre-start checklist operators get on this machine (empty = the company default). */
export async function setMachineTemplateAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const raw = String(formData.get("templateId") ?? "");
  await assertMachineInScope(getDb(), auth, id);
  await setMachineTemplate(getDb(), auth.organizationId, id, raw ? z.coerce.number().int().positive().parse(raw) : null);
  refresh();
}

/** Mark a checklist issue as fixed. A new report of the same item then opens a new issue. */
export async function resolveIssueAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  const issueId = z.coerce.number().int().positive().parse(formData.get("issueId"));
  await assertMachineInScope(getDb(), auth, id);
  await resolveIssue(getDb(), auth.organizationId, issueId, auth.userId, String(formData.get("note") ?? ""));
  refresh();
}

/** Return a locked-out machine to service. */
export async function clearLockoutAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  await assertMachineInScope(getDb(), auth, id);
  await clearLockout(getDb(), auth.organizationId, id);
  refresh();
}
