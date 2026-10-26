import { getDb } from "@/lib/db";
import { json } from "@/lib/app-api";
import { senderSettings, sendEmail } from "@/lib/notify";
import { loginCodeEmail, requestLoginCode } from "@/lib/operator-app";

/** POST { email }: emails a 6-digit code if it's an operator's address. Always the same answer (no hint who exists). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown };
  const email = typeof body.email === "string" ? body.email.slice(0, 200) : "";
  const code = await requestLoginCode(getDb(), email);
  if (code) {
    const sender = senderSettings();
    if (sender) await sendEmail(sender, [email.trim().toLowerCase()], loginCodeEmail(code));
    else if (process.env.NODE_ENV !== "production") console.log(`[operator app] sign-in code for ${email}: ${code}`);
  }
  return json({ ok: true, message: "If that email is on an operator's profile, a code is on its way." });
}
