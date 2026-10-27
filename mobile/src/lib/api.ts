import Constants from "expo-constants";
import type { Account, Checklist, CheckinResult, Me, OfflinePass } from "./types";

/** Talking to vs-lab (docs/operator-app.md). Errors carry the message to show the operator. */

export const API_URL: string = (Constants.expoConfig?.extra?.apiUrl as string | undefined) ?? "https://vs-lab-platform-tpj9.vercel.app";

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
/** No answer at all: no signal (the app then works from what it saved). */
export class OfflineError extends Error {}

async function call<T>(path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (typeof init.body === "string") headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, { ...init, headers: { ...headers, ...(init.headers as Record<string, string> | undefined) } });
  } catch {
    throw new OfflineError("No connection.");
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok && res.status !== 422) throw new ApiError(body.error ?? body.message ?? `Something went wrong (${res.status}).`, res.status);
  return body;
}

export const api = {
  requestCode: (email: string) => call<{ ok: true; message: string }>("/api/app/login", { method: "POST", body: JSON.stringify({ email }) }),
  verifyCode: (email: string, code: string, deviceName: string | null) =>
    call<{ accounts: Account[] }>("/api/app/verify", { method: "POST", body: JSON.stringify({ email, code, deviceName }) }),
  signOut: (token: string) => call<{ ok: true }>("/api/app/logout", { method: "POST", token }),
  me: (token: string) => call<Me>("/api/app/me", { token }),
  checklist: (token: string, code: string) => call<Checklist>(`/api/app/machines/${encodeURIComponent(code)}/checklist`, { token }),
  passes: (token: string) => call<{ passes: OfflinePass[] }>("/api/app/passes", { token }),
  place: (token: string, lat: number, lng: number) => call<{ place: string | null }>("/api/app/place", { method: "POST", token, body: JSON.stringify({ lat, lng }) }),
  checkIn: (token: string, code: string, form: FormData) =>
    call<CheckinResult>(`/api/app/machines/${encodeURIComponent(code)}/checkin`, { method: "POST", token, body: form }),
  reportProblem: (token: string, code: string, form: FormData) =>
    call<{ ok: true; number: number }>(`/api/app/machines/${encodeURIComponent(code)}/problem`, { method: "POST", token, body: form }),
};
