"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { getDb } from "@/lib/db";
import { createOperator, OperatorError, updateOperator } from "@/lib/operators";
import { eraseOperator, logAudit, PrivacyError } from "@/lib/privacy";

/** `name` refills the form after an error; `version` changes on every submit so the form re-renders with it. */
export type OperatorFormState = { error: string | null; version: number; name?: string; employeeNumber?: string; email?: string; phone?: string };

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
  email: z.string().max(120),
  phone: z.string().max(20),
});

export async function updateOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  const auth = await requireAuth("manager");
  const input = UpdateOperator.parse({
    id: formData.get("id"),
    name: formData.get("name") ?? "",
    active: formData.get("active") === "on",
    newPin: formData.get("newPin") ?? "",
    employeeNumber: formData.get("employeeNumber") ?? "",
    email: formData.get("email") ?? "",
    phone: formData.get("phone") ?? "",
  });
  try {
    await updateOperator(getDb(), auth.organizationId, input.id, {
      name: input.name,
      active: input.active,
      newPin: input.newPin || undefined,
      employeeNumber: input.employeeNumber,
      email: input.email,
      phone: input.phone,
    });
  } catch (err) {
    if (err instanceof OperatorError) {
      return { error: err.message, version: prev.version + 1, name: input.name, employeeNumber: input.employeeNumber, email: input.email, phone: input.phone };
    }
    throw err;
  }
  redirect("/operators");
}

/** Erases an operator's personal data (keeps the machine records). Whole-organization managers and owners. */
export async function eraseOperatorAction(prev: OperatorFormState, formData: FormData): Promise<OperatorFormState> {
  const auth = await requireAuth("manager");
  if (auth.divisionIds !== null) throw new Error("You don't have permission to do that.");
  const id = z.coerce.number().int().positive().parse(formData.get("id"));
  if (String(formData.get("confirm") ?? "").trim().toUpperCase() !== "ERASE") {
    return { error: "Type ERASE to confirm.", version: prev.version + 1 };
  }
  const db = getDb();
  try {
    const result = await eraseOperator(db, auth.organizationId, id);
    await logAudit(db, {
      organizationId: auth.organizationId,
      actor: auth.email,
      staff: auth.isPlatformAdmin,
      action: "operator-erase",
      detail: `Now "${result.placeholder}"; ${result.checkins} check-ins kept, ${result.photosDeleted} photos deleted`,
    });
  } catch (err) {
    if (err instanceof PrivacyError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  redirect("/operators");
}
