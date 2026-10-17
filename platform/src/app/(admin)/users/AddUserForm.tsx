"use client";

import { useActionState } from "react";
import { addUserAction, type UserFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";

export function AddUserForm() {
  const [state, action, pending] = useActionState(addUserAction, { error: null, version: 0 } as UserFormState);
  return (
    <form key={state.version} action={action} className="grid gap-3 sm:grid-cols-[1fr_1fr_9rem_auto] sm:items-end">
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Email</span>
        <input name="email" type="email" required defaultValue={state.email} className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Name (optional)</span>
        <input name="name" maxLength={80} className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Role</span>
        <select name="role" defaultValue="manager" className={field}>
          <option value="owner">Owner</option>
          <option value="manager">Manager</option>
          <option value="viewer">Viewer</option>
        </select>
      </label>
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60">
        {pending ? "Adding…" : "Add user"}
      </button>
      {state.error && <p className="text-sm text-red-600 sm:col-span-4">{state.error}</p>}
      {state.notice && <p className="text-sm text-emerald-700 sm:col-span-4 dark:text-emerald-400">{state.notice}</p>}
    </form>
  );
}
