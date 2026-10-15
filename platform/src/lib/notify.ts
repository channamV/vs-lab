import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, type Alert } from "@/lib/db/schema";

/**
 * Alert emails through Resend (resend.com, free tier: 3,000 emails a month). Uses Resend's HTTP API
 * directly, so swapping to another email service only means changing sendEmail().
 *
 * Settings (Vercel → Settings → Environment Variables):
 *   RESEND_API_KEY    the API key from resend.com
 *   ALERT_EMAIL_TO    who gets alerts; several addresses separated by commas
 *   ALERT_EMAIL_FROM  optional. Defaults to Resend's test sender, which can only send to the email
 *                     address you signed up to Resend with. Verify a domain in Resend to send to anyone.
 *   APP_URL           optional. The site address for links in emails (Vercel's own address is used if unset).
 */

export type EmailSettings = { apiKey: string; to: string[]; from: string };

export function emailSettings(): EmailSettings | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const to = (process.env.ALERT_EMAIL_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!apiKey || to.length === 0) return null;
  return { apiKey, to, from: process.env.ALERT_EMAIL_FROM?.trim() || "VS Lab <onboarding@resend.dev>" };
}

/** The site's public address, for links in emails. */
export function appUrl(): string | null {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

export type EmailMessage = { subject: string; text: string };

export function alertEmail(alert: Pick<Alert, "title" | "detail" | "deviceId">, baseUrl: string | null): EmailMessage {
  const link = baseUrl ? `${baseUrl}/devices/${encodeURIComponent(alert.deviceId)}` : null;
  return {
    subject: `⚠ ${alert.title}`,
    text: [
      alert.title,
      "",
      alert.detail ?? "",
      "",
      link ? `Machine: ${link}` : `Machine ID: ${alert.deviceId}`,
      baseUrl ? `All alerts: ${baseUrl}/alerts` : "",
      "",
      "— VS Lab",
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n"),
  };
}

export async function sendEmail(settings: EmailSettings, message: EmailMessage): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${settings.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: settings.from, to: settings.to, subject: message.subject, text: message.text }),
    });
    if (res.ok) return { ok: true };
    return { ok: false, error: `Resend ${res.status}: ${(await res.text()).slice(0, 300)}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Emails each new alert and records the result on the alert. Never throws. */
export async function deliverAlerts(db: Db, newAlerts: Alert[]) {
  if (newAlerts.length === 0) return;
  const settings = emailSettings();
  for (const alert of newAlerts) {
    try {
      if (!settings) {
        await db.update(alerts).set({ emailStatus: "not-configured" }).where(eq(alerts.id, alert.id));
        continue;
      }
      const result = await sendEmail(settings, alertEmail(alert, appUrl()));
      await db
        .update(alerts)
        .set(result.ok ? { emailStatus: "sent", emailError: null } : { emailStatus: "failed", emailError: result.error })
        .where(eq(alerts.id, alert.id));
    } catch (err) {
      console.error("Alert email failed", alert.id, err);
    }
  }
}
