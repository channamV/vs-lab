import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { alerts, users, type Alert } from "@/lib/db/schema";

/**
 * Email (sign-in links and alerts) through Resend (resend.com, free tier: 3,000 emails a month). Uses
 * Resend's HTTP API directly, so swapping to another email service only means changing sendEmail().
 *
 * Settings (Vercel → Settings → Environment Variables):
 *   RESEND_API_KEY    the API key from resend.com
 *   ALERT_EMAIL_FROM  optional sender, e.g. "VS Lab <alerts@veristart.ai>" (a domain verified in Resend).
 *                     Defaults to Resend's test sender, which only delivers to your own Resend address.
 *   ALERT_EMAIL_TO    optional extra addresses that get every alert from every organization (platform
 *                     staff). Each organization's owners and managers get its alerts automatically.
 *   APP_URL           optional. The site address for links in emails (Vercel's own address is used if unset).
 */

export type Sender = { apiKey: string; from: string };

export function senderSettings(): Sender | null {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return null;
  return { apiKey, from: process.env.ALERT_EMAIL_FROM?.trim() || "VS Lab <onboarding@resend.dev>" };
}

const splitEmails = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

/**
 * Who gets an organization's alerts: its active owners and managers, plus ALERT_EMAIL_TO.
 * (Per-user alert subscriptions will replace this.)
 */
export async function alertRecipients(db: Db, organizationId: number): Promise<string[]> {
  const rows = await db
    .select({ email: users.email })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.active, true), inArray(users.role, ["owner", "manager"])));
  return [...new Set([...rows.map((r) => r.email), ...splitEmails(process.env.ALERT_EMAIL_TO)])];
}

/** The site's public address, for links in emails. */
export function appUrl(): string | null {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return null;
}

export type EmailMessage = { subject: string; text: string };

export function alertEmail(alert: Pick<Alert, "title" | "detail" | "machineId">, baseUrl: string | null): EmailMessage {
  const link = baseUrl ? `${baseUrl}/machines/${alert.machineId}` : null;
  return {
    subject: `⚠ ${alert.title}`,
    text: [
      alert.title,
      "",
      alert.detail ?? "",
      "",
      link ? `Machine: ${link}` : "",
      baseUrl ? `All alerts: ${baseUrl}/alerts` : "",
      "",
      "— VS Lab",
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n"),
  };
}

export async function sendEmail(
  sender: Sender,
  to: string[],
  message: EmailMessage,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${sender.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: sender.from, to, subject: message.subject, text: message.text }),
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
  const sender = senderSettings();
  for (const alert of newAlerts) {
    try {
      const to = await alertRecipients(db, alert.organizationId);
      if (!sender || to.length === 0) {
        await db
          .update(alerts)
          .set({ emailStatus: sender ? "no-recipients" : "not-configured" })
          .where(eq(alerts.id, alert.id));
        continue;
      }
      // Recipients don't see each other's addresses: one email per person.
      const results = await Promise.all(to.map((address) => sendEmail(sender, [address], alertEmail(alert, appUrl()))));
      const failed = results.find((r) => !r.ok);
      const result = failed ?? { ok: true as const };
      await db
        .update(alerts)
        .set(result.ok ? { emailStatus: "sent", emailError: null } : { emailStatus: "failed", emailError: result.error })
        .where(eq(alerts.id, alert.id));
    } catch (err) {
      console.error("Alert email failed", alert.id, err);
    }
  }
}

export function signInEmail(link: string, minutes: number): EmailMessage {
  return {
    subject: "Your VS Lab sign-in link",
    text: [
      "Click to sign in to VS Lab:",
      "",
      link,
      "",
      `The link works once, for ${minutes} minutes. If you didn't ask for it, ignore this email.`,
      "",
      "— VS Lab",
    ].join("\n"),
  };
}
