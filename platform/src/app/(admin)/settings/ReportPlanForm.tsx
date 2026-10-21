"use client";

import { useActionState } from "react";
import { saveReportPlanAction, type PlanFormState } from "./actions";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Hours per working day and working days, for utilization in Reports. */
export function ReportPlanForm({ hours, days }: { hours: number; days: number[] }) {
  const [state, action, pending] = useActionState(saveReportPlanAction, { error: null, saved: false, version: 0 } as PlanFormState);
  return (
    <form action={action} className="space-y-3">
      <label className="block text-sm">
        <span className="font-medium">Hours per working day</span>
        <span className="block text-slate-500">How long a machine is expected to run on a working day (e.g. 8 or 10).</span>
        <input
          name="plannedHoursPerDay"
          type="number"
          step="0.25"
          min="0.25"
          max="24"
          required
          defaultValue={hours}
          className="mt-1 w-32 rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
        />
      </label>
      <fieldset>
        <legend className="text-sm font-medium">Working days</legend>
        <div className="mt-1 flex flex-wrap gap-3 text-sm">
          {DAYS.map((label, i) => (
            <label key={label} className="flex items-center gap-1">
              <input type="checkbox" name="workingDay" value={i} defaultChecked={days.includes(i)} /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.saved && <p className="text-sm text-emerald-700">Saved.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
