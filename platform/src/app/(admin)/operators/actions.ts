"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { getDb } from "@/lib/db";
import { createOperator, OperatorError, updateOperator } from "@/lib/operators";

/** `name` refills the form after an error; `version` changes on every submit so the form re-renders with it. */
export type OperatorFormState = { error: string | null; version: number; name?: string };

export async function addOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").slice(0, 80);
  try {
    await createOperator(getDb(), { name, pin: String(formData.get("pin") ?? "").trim() });
  } catch (err) {
    if (err instanceof OperatorError) return { error: err.message, version: prev.version + 1, name };
    throw err;
  }
  refresh();
  return { error: null, version: prev.version + 1 };
}

const UpdateOperator = z.object({
  id: z.coerce.number().int().positive(),
  name: z.string().max(80),
  active: z.boolean(),
  newPin: z.string().trim().max(16),
});

export async function updateOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  await requireAdmin();
  const input = UpdateOperator.parse({
    id: formData.get("id"),
    name: formData.get("name") ?? "",
    active: formData.get("active") === "on",
    newPin: formData.get("newPin") ?? "",
  });
  try {
    await updateOperator(getDb(), input.id, { name: input.name, active: input.active, newPin: input.newPin || undefined });
  } catch (err) {
    if (err instanceof OperatorError) return { error: err.message, version: prev.version + 1, name: input.name };
    throw err;
  }
  redirect("/operators");
}
