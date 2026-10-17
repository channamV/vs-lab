"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAuth } from "@/lib/session";
import { acknowledgeAlert } from "@/lib/alerts";
import { getDb } from "@/lib/db";
import { alertRecipients, appUrl, senderSettings, sendEmail } from "@/lib/notify";

export async function acknowledgeAction(formData: FormData) {
  const auth = await requireAuth("manager");
  const id = z.coerce.number().int().positive().parse(formData.get("alertId"));
  await acknowledgeAlert(getDb(), auth.organizationId, id, String(formData.get("note") ?? "").slice(0, 500));
  refresh();
}

export type TestEmailState = { message: string | null; ok?: boolean };

export async function sendTestEmailAction(): Promise<TestEmailState> {
  const auth = await requireAuth("manager");
  const sender = senderSettings();
  if (!sender) return { ok: false, message: "Email isn't set up yet: add RESEND_API_KEY in Vercel, then redeploy." };
  const base = appUrl();
  const result = await sendEmail(sender, [auth.email], {
    subject: "VS Lab test email",
    text: `Alert emails are working.${base ? `\n\n${base}/alerts` : ""}\n\n— VS Lab`,
  });
  if (!result.ok) return { ok: false, message: `Sending failed: ${result.error}` };
  const recipients = await alertRecipients(getDb(), auth.organizationId);
  return {
    ok: true,
    message: `Sent to ${auth.email}. ${auth.organizationName} alerts go to: ${recipients.join(", ") || "nobody yet (add an owner or manager)"}.`,
  };
}
