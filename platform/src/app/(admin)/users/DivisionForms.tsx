"use client";

import { useActionState } from "react";
import { divisionAction, type DivisionFormState } from "./actions";

const field = "rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700";
const button = "rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800";

export function AddDivisionForm() {
  const [state, action, pending] = useActionState(divisionAction, { error: null, version: 0 } as DivisionFormState);
  return (
    <form key={state.version} action={action} className="flex flex-wrap items-center gap-2">
      <input name="name" required maxLength={80} defaultValue={state.name} placeholder="e.g. Ontario, Paving" className={field} />
      <button name="intent" value="create" disabled={pending} className={button}>
        Add division
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}

export function DivisionRow({ division }: { division: { id: number; name: string; machines: number; users: number } }) {
  const [state, action, pending] = useActionState(divisionAction, { error: null, version: 0 } as DivisionFormState);
  return (
    <form key={state.version} action={action} className="flex flex-wrap items-center gap-2 py-2">
      <input type="hidden" name="divisionId" value={division.id} />
      <input name="name" required maxLength={80} defaultValue={state.name ?? division.name} className={field} />
      <span className="text-xs text-slate-500">
        {division.machines} machine{division.machines === 1 ? "" : "s"} · {division.users} limited user{division.users === 1 ? "" : "s"}
      </span>
      <button name="intent" value="rename" disabled={pending} className={button}>
        Rename
      </button>
      <button name="intent" value="delete" disabled={pending} className={button}>
        Delete
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
