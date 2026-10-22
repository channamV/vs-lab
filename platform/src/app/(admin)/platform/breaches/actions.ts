"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { BreachError, recordBreach, updateBreach, type BreachInput } from "@/lib/breaches";
import { getDb } from "@/lib/db";
import { requirePlatformAdmin } from "@/lib/session";

/** Platform admins (Veristart staff) only: the privacy breach register. */

export type BreachFormState = { error: string | null; saved: boolean; version: number; values?: BreachInput };

const FIELDS = [
  "occurredAt",
  "discoveredAt",
  "description",
  "dataInvolved",
  "organizationsAffected",
  "peopleAffected",
  "realRisk",
  "riskReasoning",
  "reportedToCommissionerAt",
  "individualsNotifiedAt",
  "customersNotifiedAt",
  "actionsTaken",
] as const;

export async function saveBreachAction(prev: BreachFormState, formData: FormData): Promise<BreachFormState> {
  const auth = await requirePlatformAdmin();
  const values = {
    ...(Object.fromEntries(FIELDS.map((f) => [f, String(formData.get(f) ?? "").slice(0, 4000)])) as Omit<BreachInput, "closed">),
    closed: formData.get("closed") === "on",
  };
  const id = z.string().regex(/^\d*$/).parse(formData.get("id") ?? "");
  try {
    if (id) await updateBreach(getDb(), Number(id), values);
    else await recordBreach(getDb(), values, auth.email);
  } catch (err) {
    if (err instanceof BreachError) return { error: err.message, saved: false, version: prev.version + 1, values };
    throw err;
  }
  refresh();
  return { error: null, saved: true, version: prev.version + 1 };
}
