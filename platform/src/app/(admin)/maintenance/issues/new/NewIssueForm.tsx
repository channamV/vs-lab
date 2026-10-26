"use client";

import { useActionState } from "react";
import { machineLabel } from "@/lib/format";
import { PRIORITIES, PRIORITY_CHOICES } from "@/lib/maintenance-types";
import { createIssueAction, type FormState } from "../../actions";

const idle: FormState = { status: "idle" };
const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900";

export function NewIssueForm({ machines, machineId }: { machines: { id: number; name: string; unitNumber: string | null }[]; machineId: string }) {
  const [state, action, pending] = useActionState(createIssueAction, idle);
  const v = state.values;
  return (
    <form key={state.attempt} action={action} className="space-y-4">
      <label className="block space-y-1">
        <span className="text-sm font-medium">Machine</span>
        <select name="machineId" required defaultValue={v?.machineId ?? machineId} className={field}>
          <option value="">Choose…</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {machineLabel(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Title</span>
        <input name="title" required maxLength={200} defaultValue={v?.title} placeholder="e.g. Hydraulic leak at the boom" className={field} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Priority</span>
        <select name="priority" defaultValue={v?.priority ?? "minor"} className={field}>
          {PRIORITY_CHOICES.map((p) => (
            <option key={p} value={p}>
              {PRIORITIES[p].label}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Complaint</span>
        <span className="block text-xs text-slate-500">What was found or reported. Add photos on the next page.</span>
        <textarea name="complaint" rows={4} maxLength={4000} defaultValue={v?.complaint} className={field} />
      </label>
      {state.status === "error" && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{state.message}</p>}
      <button disabled={pending} className="min-h-11 w-full rounded-lg bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-50 sm:w-auto">
        {pending ? "Adding…" : "Add item"}
      </button>
    </form>
  );
}
