"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { requireAuth } from "@/lib/session";
import { createRule, deleteRule, NotificationError, setRuleEnabled, updateRule } from "@/lib/notifications";

/**
 * Everyone (viewers too) manages their own subscriptions; owners can manage anyone's in their
 * organization. Returns the organization the subscriptions' owner belongs to.
 */
async function organizationFor(userId: number) {
  const auth = await requireAuth();
  if (userId === auth.userId) return auth.homeOrganizationId;
  if (!hasRole(auth, "owner")) throw new NotificationError("Only owners can change other people's subscriptions.");
  return auth.organizationId;
}

export type RuleFormState = { error: string | null; version: number };

const ids = z.array(z.coerce.number().int().nonnegative());
const RuleForm = z.object({
  userId: z.coerce.number().int().positive(),
  ruleId: z.string().regex(/^\d*$/),
  name: z.string().max(80),
  eventTypes: z.array(z.string().max(40)),
  machineIds: ids,
  divisionIds: ids,
  operatorIds: ids,
  worksiteIds: ids,
  weekdays: ids,
  startTime: z.string().max(5),
  endTime: z.string().max(5),
});

export async function saveRuleAction(prev: RuleFormState, formData: FormData): Promise<RuleFormState> {
  const input = RuleForm.parse({
    userId: formData.get("userId"),
    ruleId: formData.get("ruleId") ?? "",
    name: formData.get("name") ?? "",
    eventTypes: formData.getAll("eventType"),
    machineIds: formData.getAll("machine"),
    divisionIds: formData.getAll("division"),
    operatorIds: formData.getAll("operator"),
    worksiteIds: formData.getAll("worksite"),
    weekdays: formData.getAll("weekday"),
    startTime: formData.get("startTime") ?? "",
    endTime: formData.get("endTime") ?? "",
  });
  try {
    const organizationId = await organizationFor(input.userId);
    if (input.ruleId) await updateRule(getDb(), organizationId, input.userId, Number(input.ruleId), input);
    else await createRule(getDb(), organizationId, input.userId, input);
  } catch (err) {
    if (err instanceof NotificationError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  const auth = await requireAuth();
  redirect(input.userId === auth.userId ? "/alerts/subscriptions" : `/alerts/subscriptions?user=${input.userId}`);
}

const RuleRef = z.object({ userId: z.coerce.number().int().positive(), ruleId: z.coerce.number().int().positive() });

export async function setRuleEnabledAction(formData: FormData) {
  const { userId, ruleId } = RuleRef.parse({ userId: formData.get("userId"), ruleId: formData.get("ruleId") });
  await setRuleEnabled(getDb(), await organizationFor(userId), userId, ruleId, formData.get("enabled") === "true");
  refresh();
}

export async function deleteRuleAction(formData: FormData) {
  const { userId, ruleId } = RuleRef.parse({ userId: formData.get("userId"), ruleId: formData.get("ruleId") });
  await deleteRule(getDb(), await organizationFor(userId), userId, ruleId);
  refresh();
}
