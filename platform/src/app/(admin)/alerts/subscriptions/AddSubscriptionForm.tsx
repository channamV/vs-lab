"use client";

import { useActionState } from "react";
import { addSubscriptionAction, type SubscriptionFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";

export function AddSubscriptionForm({
  userId,
  types,
  divisions,
  machines,
}: {
  userId: number;
  types: { value: string; label: string }[];
  divisions: { id: number; name: string }[];
  machines: { id: number; label: string }[];
}) {
  const [state, action, pending] = useActionState(addSubscriptionAction, { error: null, version: 0 } as SubscriptionFormState);
  return (
    <form key={state.version} action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_10rem_auto] sm:items-end">
      <input type="hidden" name="userId" value={userId} />
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Alert</span>
        <select name="type" className={field}>
          <option value="all">All alerts</option>
          {types.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">For</span>
        <select name="where" className={field}>
          <option value="all">All machines</option>
          {divisions.length > 0 && (
            <optgroup label="Division">
              {divisions.map((d) => (
                <option key={d.id} value={`d:${d.id}`}>
                  {d.name} division
                </option>
              ))}
            </optgroup>
          )}
          {machines.length > 0 && (
            <optgroup label="Machine">
              {machines.map((m) => (
                <option key={m.id} value={`m:${m.id}`}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">By</span>
        <select name="channel" className={field}>
          <option value="email">Email</option>
          <option disabled>Text message (later)</option>
        </select>
      </label>
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60">
        {pending ? "Adding…" : "Subscribe"}
      </button>
      {state.error && <p className="text-sm text-red-600 sm:col-span-4">{state.error}</p>}
    </form>
  );
}
