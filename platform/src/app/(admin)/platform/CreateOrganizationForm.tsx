"use client";

import { useActionState } from "react";
import { createOrganizationAction, type PlatformFormState } from "./actions";

export function CreateOrganizationForm() {
  const [state, action, pending] = useActionState(createOrganizationAction, { error: null, version: 0 } as PlatformFormState);
  return (
    <form key={state.version} action={action} className="flex flex-wrap gap-2">
      <input
        name="name"
        required
        maxLength={120}
        placeholder="e.g. ABC Civil Ltd."
        className="min-w-0 flex-1 rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
      />
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60">
        {pending ? "Creating…" : "Create organization"}
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
