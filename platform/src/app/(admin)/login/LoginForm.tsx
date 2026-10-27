"use client";

import { useActionState } from "react";
import { useSearchParams } from "next/navigation";
import { requestLinkAction, verifyLinkAction, type LoginState } from "./actions";

const empty: LoginState = { message: null };
const input = "w-full rounded border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700";
const button = "w-full rounded bg-sky-700 px-3 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-60";

function Message({ state }: { state: LoginState }) {
  if (!state.message) return null;
  return <p className={`text-sm ${state.error ? "text-red-600" : "text-emerald-700 dark:text-emerald-400"}`}>{state.message}</p>;
}

export function EmailLinkForm() {
  const [state, action, pending] = useActionState(requestLinkAction, empty);
  const next = useSearchParams().get("next") ?? "/";
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="next" value={next} />
      <input type="email" name="email" autoFocus required autoComplete="email" placeholder="you@company.com" className={input} />
      <button disabled={pending} className={button}>
        {pending ? "Sending…" : "Email me a sign-in link"}
      </button>
      <Message state={state} />
    </form>
  );
}

export function VerifyForm() {
  const [state, action, pending] = useActionState(verifyLinkAction, empty);
  const params = useSearchParams();
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="token" value={params.get("token") ?? ""} />
      <input type="hidden" name="next" value={params.get("next") ?? "/"} />
      <button disabled={pending} className={button}>
        {pending ? "Signing in…" : "Sign in to VS Lab"}
      </button>
      <Message state={state} />
    </form>
  );
}
