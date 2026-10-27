"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { AUTH_RULES, endSession, redeemSignInLink, requestSignInLink, SESSION_COOKIE } from "@/lib/auth";
import { appUrl, senderSettings, sendEmail, signInEmail } from "@/lib/notify";
import { safeNext, setSessionCookie } from "@/lib/session";

export type LoginState = { message: string | null; error?: boolean };

/** Emails a one-time sign-in link. Same answer whether or not the email has an account. */
export async function requestLinkAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").slice(0, 200);
  const next = safeNext(formData.get("next"));
  const token = await requestSignInLink(getDb(), email);
  const sent: LoginState = {
    message: `If ${email.trim()} has a VS Lab account, a sign-in link is on its way. It works for ${AUTH_RULES.linkMinutes} minutes. Check your junk folder too.`,
  };
  if (!token) return sent;

  const h = await headers();
  const base = appUrl() ?? `${h.get("x-forwarded-proto") ?? "http"}://${h.get("x-forwarded-host") ?? h.get("host")}`;
  const link = `${base}/login/verify?token=${encodeURIComponent(token)}${next !== "/" ? `&next=${encodeURIComponent(next)}` : ""}`;
  const sender = senderSettings();
  if (!sender) {
    if (process.env.VERCEL) return { error: true, message: "Email isn't set up on this site (RESEND_API_KEY), so sign-in links can't be sent." };
    // Running on your own PC without email: print the link where you started the server.
    console.log(`\n  Sign-in link for ${email.trim()}:\n  ${link}\n`);
    return { message: "Email isn't set up on this computer: the sign-in link was printed in the terminal window running the server." };
  }
  const result = await sendEmail(sender, [email.trim().toLowerCase()], signInEmail(link, AUTH_RULES.linkMinutes));
  if (!result.ok) console.error("Sign-in email failed", result.error);
  return sent;
}

/** The button on the page the emailed link opens. (A button, not the link itself, signs in: email
 * security scanners open links automatically, which would use up a one-time link.) */
export async function verifyLinkAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const session = await redeemSignInLink(getDb(), String(formData.get("token") ?? ""));
  if (!session) return { error: true, message: "This sign-in link has expired or was already used. Ask for a new one." };
  await setSessionCookie(session.token, session.expiresAt);
  redirect(safeNext(formData.get("next")));
}

export async function signOutAction() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await endSession(getDb(), token);
  store.delete(SESSION_COOKIE);
  redirect("/login");
}
