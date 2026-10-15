/**
 * Minimal single-password sign-in for the lab platform.
 *
 * - ADMIN_PASSWORD unset → sign-in is disabled (fine on your own PC, never on the internet).
 * - ADMIN_PASSWORD set   → every page requires the password. Device endpoints (/hub/api/*) stay open.
 *
 * The session cookie holds an HMAC of a fixed message keyed by the password, so changing the
 * password signs everyone out. Replace with real per-user accounts before giving anyone else access.
 */
export const SESSION_COOKIE = "vslab_session";

export function authEnabled(): boolean {
  return Boolean(process.env.ADMIN_PASSWORD);
}

async function hmacHex(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sessionToken(): Promise<string> {
  return hmacHex(process.env.ADMIN_PASSWORD ?? "", "vs-lab-session-v1");
}

/** Constant-time comparison so response timing doesn't leak how much of a value matched. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function isValidSession(cookieValue: string | undefined): Promise<boolean> {
  if (!authEnabled()) return true;
  if (!cookieValue) return false;
  return safeEqual(cookieValue, await sessionToken());
}

export async function isCorrectPassword(password: string): Promise<boolean> {
  const expected = process.env.ADMIN_PASSWORD ?? "";
  // Compare HMACs rather than raw strings so lengths don't leak.
  return safeEqual(await hmacHex("vs-lab-pw", password), await hmacHex("vs-lab-pw", expected));
}
