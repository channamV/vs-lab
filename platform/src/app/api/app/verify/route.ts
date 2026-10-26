import { getDb } from "@/lib/db";
import { fail, json } from "@/lib/app-api";
import { verifyLoginCode } from "@/lib/operator-app";

/** POST { email, code, deviceName }: the code from the email → a sign-in token per company (usually one). */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { email?: unknown; code?: unknown; deviceName?: unknown };
  if (typeof body.email !== "string" || typeof body.code !== "string") return fail("Enter your email and the code.");
  const accounts = await verifyLoginCode(getDb(), body.email.slice(0, 200), body.code.slice(0, 12), typeof body.deviceName === "string" ? body.deviceName : null);
  if (!accounts?.length) return fail("That code didn't work. Check it, or ask for a new one.", 401);
  return json({ accounts });
}
