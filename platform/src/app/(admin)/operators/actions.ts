"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/lib/db";
import { createOperator, OperatorError, updateOperator } from "@/lib/operators";

/** `name` refills the form after an error; `version` changes on every submit so the form re-renders with it. */
export type OperatorFormState = { error: string | null; version: number; name?: string; employeeNumber?: string };

export async function addOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  const auth = await requireAuth("manager");
  const name = String(formData.get("name") ?? "").slice(0, 80);
  try {
    await createOperator(getDb(), auth.organizationId, {
      name,
      pin: String(formData.get("pin") ?? "").trim(),
      employeeNumber: String(formData.get("employeeNumber") ?? "").slice(0, 40),
    });
  } catch (err) {
    if (err instanceof OperatorError) {
      return { error: err.message, version: prev.version + 1, name, employeeNumber: String(formData.get("employeeNumber") ?? "") };
    }
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
  employeeNumber: z.string().max(40),
});

export async function updateOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  const auth = await requireAuth("manager");
  const input = UpdateOperator.parse({
    id: formData.get("id"),
    name: formData.get("name") ?? "",
    active: formData.get("active") === "on",
    newPin: formData.get("newPin") ?? "",
    employeeNumber: formData.get("employeeNumber") ?? "",
  });
  try {
    await updateOperator(getDb(), auth.organizationId, input.id, {
      name: input.name,
      active: input.active,
      newPin: input.newPin || undefined,
      employeeNumber: input.employeeNumber,
    });
  } catch (err) {
    if (err instanceof OperatorError) {
      return { error: err.message, version: prev.version + 1, name: input.name, employeeNumber: input.employeeNumber };
    }
    throw err;
  }
  redirect("/operators");
}
