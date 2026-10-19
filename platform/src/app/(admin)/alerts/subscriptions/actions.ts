"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { hasRole } from "@/lib/auth";
import { ALERT_LABELS } from "@/lib/alerts";
import { requireAuth } from "@/lib/session";
import { addSubscription, ALERT_CHANNELS, removeSubscription, SubscriptionError } from "@/lib/subscriptions";

/**
 * Everyone (viewers too) manages their own alert subscriptions; owners can manage anyone's in their
 * organization. Returns the organization the user belongs to, or throws.
 */
async function organizationFor(userId: number) {
  const auth = await requireAuth();
  if (userId === auth.userId) return auth.homeOrganizationId;
  if (!hasRole(auth, "owner")) throw new SubscriptionError("Only owners can change other people's alerts.");
  return auth.organizationId;
}

export type SubscriptionFormState = { error: string | null; version: number };

const AddInput = z.object({
  userId: z.coerce.number().int().positive(),
  type: z.enum(["all", ...(Object.keys(ALERT_LABELS) as [string, ...string[]])]),
  /** "all", "d:<division id>" or "m:<machine id>" */
  where: z.string().regex(/^(all|[dm]:\d+)$/),
  channel: z.enum(Object.keys(ALERT_CHANNELS) as [keyof typeof ALERT_CHANNELS]),
});

export async function addSubscriptionAction(prev: SubscriptionFormState, formData: FormData): Promise<SubscriptionFormState> {
  const input = AddInput.parse({
    userId: formData.get("userId"),
    type: formData.get("type"),
    where: formData.get("where"),
    channel: formData.get("channel"),
  });
  const [kind, id] = input.where.split(":");
  try {
    const organizationId = await organizationFor(input.userId);
    await addSubscription(getDb(), organizationId, input.userId, {
      type: input.type === "all" ? null : (input.type as keyof typeof ALERT_LABELS),
      divisionId: kind === "d" ? Number(id) : null,
      machineId: kind === "m" ? Number(id) : null,
      channel: input.channel,
    });
  } catch (err) {
    if (err instanceof SubscriptionError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

export async function removeSubscriptionAction(formData: FormData) {
  const userId = z.coerce.number().int().positive().parse(formData.get("userId"));
  const id = z.coerce.number().int().positive().parse(formData.get("subscriptionId"));
  await removeSubscription(getDb(), await organizationFor(userId), userId, id);
  refresh();
}
