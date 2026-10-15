"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { requireAdmin } from "@/lib/admin";
import { acknowledgeAlert } from "@/lib/alerts";
import { getDb } from "@/lib/db";
import { appUrl, emailSettings, sendEmail } from "@/lib/notify";

export async function acknowledgeAction(formData: FormData) {
  await requireAdmin();
  const id = z.coerce.number().int().positive().parse(formData.get("alertId"));
  await acknowledgeAlert(getDb(), id, String(formData.get("note") ?? "").slice(0, 500));
  refresh();
}

export type TestEmailState = { message: string | null; ok?: boolean };

export async function sendTestEmailAction(): Promise<TestEmailState> {
  await requireAdmin();
  const settings = emailSettings();
  if (!settings) {
    return { ok: false, message: "Email isn't set up yet: add RESEND_API_KEY and ALERT_EMAIL_TO in Vercel, then redeploy." };
  }
  const base = appUrl();
  const result = await sendEmail(settings, {
    subject: "VS Lab test email",
    text: `Alert emails are working. Alerts will be sent to ${settings.to.join(", ")}.${base ? `\n\n${base}/alerts` : ""}\n\n— VS Lab`,
  });
  return result.ok
    ? { ok: true, message: `Sent to ${settings.to.join(", ")}. Check your inbox (and spam folder).` }
    : { ok: false, message: `Sending failed: ${result.error}` };
}
