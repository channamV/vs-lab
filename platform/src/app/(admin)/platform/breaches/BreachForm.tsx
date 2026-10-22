"use client";

import { useActionState } from "react";
import type { BreachInput } from "@/lib/breaches";
import { saveBreachAction, type BreachFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const label = "text-slate-600 dark:text-slate-400";

/** New record (no id) or an existing one. Dates are calendar days. */
export function BreachForm({ id, initial }: { id?: number; initial?: BreachInput }) {
  const [state, action, pending] = useActionState(saveBreachAction, { error: null, saved: false, version: 0 } as BreachFormState);
  // After a new record is saved, start again with an empty form; after an error, keep what was typed.
  const v = state.values ?? (id ? initial : undefined);
  const text = (name: keyof BreachInput, title: string, help?: string) => (
    <label className="block text-sm">
      <span className={label}>{title}</span>
      <textarea name={name} rows={2} maxLength={4000} defaultValue={(v?.[name] as string) ?? ""} className={field} />
      {help && <span className="text-xs text-slate-500">{help}</span>}
    </label>
  );
  const day = (name: keyof BreachInput, title: string, required = false) => (
    <label className="block text-sm">
      <span className={label}>{title}</span>
      <input type="date" name={name} required={required} defaultValue={(v?.[name] as string) ?? ""} className={field} />
    </label>
  );
  return (
    <form key={state.version} action={action} className="space-y-3">
      <input type="hidden" name="id" value={id ?? ""} />
      <div className="grid gap-3 sm:grid-cols-2">
        {day("discoveredAt", "Discovered on", true)}
        {day("occurredAt", "Happened on (if known)")}
      </div>
      {text("description", "What happened")}
      {text("dataInvolved", "Personal information involved", "e.g. operator names and PINs, phone locations, check-in photos")}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className={label}>Customers affected</span>
          <input name="organizationsAffected" maxLength={1000} defaultValue={v?.organizationsAffected ?? ""} className={field} />
        </label>
        <label className="block text-sm">
          <span className={label}>People affected (approximate)</span>
          <input name="peopleAffected" inputMode="numeric" defaultValue={v?.peopleAffected ?? ""} className={field} />
        </label>
      </div>
      <label className="block text-sm">
        <span className={label}>Real risk of significant harm?</span>
        <select name="realRisk" defaultValue={v?.realRisk ?? ""} className={field}>
          <option value="">Not assessed yet</option>
          <option value="yes">Yes: report and notify</option>
          <option value="no">No</option>
        </select>
        <span className="text-xs text-slate-500">
          Consider how sensitive the information is and how likely it is to be misused (e.g. identity theft, humiliation, loss of
          employment, physical harm).
        </span>
      </label>
      {text("riskReasoning", "Why (the assessment)")}
      <div className="grid gap-3 sm:grid-cols-3">
        {day("reportedToCommissionerAt", "Reported to the Commissioner")}
        {day("individualsNotifiedAt", "People notified")}
        {day("customersNotifiedAt", "Customers told")}
      </div>
      {text("actionsTaken", "What was done", "Containment, and what changed so it doesn't happen again")}
      {id && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="closed" defaultChecked={v?.closed ?? false} /> Closed (nothing left to do)
        </label>
      )}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.saved && <p className="text-sm text-emerald-700">Saved.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Saving…" : id ? "Save changes" : "Add to register"}
      </button>
    </form>
  );
}
