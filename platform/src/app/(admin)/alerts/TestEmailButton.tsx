"use client";

import { useActionState } from "react";
import { sendTestEmailAction, type TestEmailState } from "./actions";

export function TestEmailButton() {
  const [state, action, pending] = useActionState(sendTestEmailAction, { message: null } as TestEmailState);
  return (
    <form action={action} className="flex flex-wrap items-center gap-3">
      <button disabled={pending} className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800">
        {pending ? "Sending…" : "Send test email"}
      </button>
      {state.message && (
        <span className={`text-sm ${state.ok ? "text-emerald-700 dark:text-emerald-400" : "text-red-600"}`}>{state.message}</span>
      )}
    </form>
  );
}
