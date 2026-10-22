"use client";

import { useActionState } from "react";
import { addOperatorAction, eraseOperatorAction, updateOperatorAction, type OperatorFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const button = "rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";
const pinProps = { inputMode: "numeric" as const, pattern: "[0-9]{4,8}", maxLength: 8, autoComplete: "off" };

export function AddOperatorForm() {
  const [state, action, pending] = useActionState(addOperatorAction, { error: null, version: 0 } as OperatorFormState);
  return (
    // key: rebuild the form after each submit: empty after an add, the typed name kept after an error
    <form key={state.version} action={action} className="grid gap-3 sm:grid-cols-[1fr_9rem_9rem_auto] sm:items-end">
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Name</span>
        <input name="name" required maxLength={80} defaultValue={state.name} placeholder="e.g. Jane Smith" className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Employee # (optional)</span>
        <input name="employeeNumber" maxLength={40} defaultValue={state.employeeNumber} className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">PIN (4–8 digits)</span>
        <input name="pin" required {...pinProps} className={field} />
      </label>
      <button disabled={pending} className={button}>
        {pending ? "Adding…" : "Add operator"}
      </button>
      {state.error && <p className="text-sm text-red-600 sm:col-span-4">{state.error}</p>}
    </form>
  );
}

export function EditOperatorForm({
  operator,
}: {
  operator: { id: number; name: string; active: boolean; employeeNumber: string | null; email: string | null; phone: string | null };
}) {
  const [state, action, pending] = useActionState(updateOperatorAction, { error: null, version: 0 } as OperatorFormState);
  return (
    <form key={state.version} action={action} className="space-y-3">
      <input type="hidden" name="id" value={operator.id} />
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Name</span>
        <input name="name" required maxLength={80} defaultValue={state.name ?? operator.name} className={field} />
      </label>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Employee # (optional, tells people with the same name apart)</span>
        <input
          name="employeeNumber"
          maxLength={40}
          defaultValue={state.employeeNumber ?? operator.employeeNumber ?? ""}
          className={field}
        />
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Email (optional)</span>
          <input name="email" type="email" maxLength={120} defaultValue={state.email ?? operator.email ?? ""} className={field} />
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Mobile number (optional)</span>
          <input name="phone" type="tel" maxLength={20} defaultValue={state.phone ?? operator.phone ?? ""} placeholder="e.g. 416 555 0123" className={field} />
        </label>
      </div>
      <p className="text-xs text-slate-500">Used for the operator&apos;s own training expiry reminders (email now; text messages once SMS is set up).</p>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">New PIN (leave empty to keep the current one)</span>
        <input name="newPin" {...pinProps} className={field} />
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name="active" defaultChecked={operator.active} />
        Active (unticking checks them out and stops them checking in)
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** Right to erasure: removes the operator's personal data; check-ins stay under "Former operator #id". */
export function EraseOperatorForm({ operatorId }: { operatorId: number }) {
  const [state, action, pending] = useActionState(eraseOperatorAction, { error: null, version: 0 } as OperatorFormState);
  return (
    <form key={state.version} action={action} className="space-y-2">
      <input type="hidden" name="id" value={operatorId} />
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Type ERASE to confirm</span>
        <input name="confirm" autoComplete="off" className={field} />
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="rounded bg-red-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-800 disabled:opacity-60">
        {pending ? "Erasing…" : "Erase this operator's data"}
      </button>
    </form>
  );
}
