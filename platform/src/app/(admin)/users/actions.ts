"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { roleEnum } from "@/lib/db/schema";
import { appUrl, senderSettings, sendEmail } from "@/lib/notify";
import { AccountError, addUser, updateUser } from "@/lib/organizations";
import { requireAuth } from "@/lib/session";

/** Owners manage their organization's users. */

export type UserFormState = { error: string | null; notice?: string; version: number; email?: string };

export async function addUserAction(prev: UserFormState, formData: FormData): Promise<UserFormState> {
  const auth = await requireAuth("owner");
  const email = String(formData.get("email") ?? "").slice(0, 200);
  const role = z.enum(roleEnum.enumValues).parse(formData.get("role"));
  try {
    const user = await addUser(getDb(), auth.organizationId, { email, name: String(formData.get("name") ?? ""), role });
    // Let them know (best effort: they can always just go to the sign-in page).
    const sender = senderSettings();
    const base = appUrl();
    if (sender && base) {
      await sendEmail(sender, [user.email], {
        subject: `You've been added to VS Lab (${auth.organizationName})`,
        text: `${auth.email} added you to ${auth.organizationName} on VS Lab.\n\nSign in with this email address at:\n${base}/login\n\n— VS Lab`,
      });
    }
    refresh();
    return { error: null, notice: `Added ${user.email}. They sign in with that address at the sign-in page.`, version: prev.version + 1 };
  } catch (err) {
    if (err instanceof AccountError) return { error: err.message, version: prev.version + 1, email };
    throw err;
  }
}

export async function updateUserAction(formData: FormData) {
  const auth = await requireAuth("owner");
  const input = z
    .object({ id: z.coerce.number().int().positive(), role: z.enum(roleEnum.enumValues), active: z.boolean() })
    .parse({ id: formData.get("id"), role: formData.get("role"), active: formData.get("active") === "on" });
  try {
    await updateUser(getDb(), auth.organizationId, input.id, { role: input.role, active: input.active });
  } catch (err) {
    if (err instanceof AccountError) throw new Error(err.message);
    throw err;
  }
  refresh();
}
