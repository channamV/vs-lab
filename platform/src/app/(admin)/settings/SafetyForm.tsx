"use client";

import { useActionState } from "react";
import { saveSafetySettingsAction, type SettingsFormState } from "./actions";

type Current = { speedLimitKph: number | null; idleAlertMinutes: number | null; fatigueDailyHours: number | null; fatigueContinuousHours: number | null };

const FIELDS = [
  { name: "speedLimitKph", label: "Fleet speed limit (km/h)", help: "Speeding = over this for more than 10 seconds (GPS speed). Worksites can set a lower limit of their own.", step: "1" },
  { name: "idleAlertMinutes", label: "Excessive idling after (minutes)", help: "Engine running at low RPM and not moving for this long. Only machines whose device reads engine RPM.", step: "1" },
  { name: "fatigueDailyHours", label: "Operator hours per day", help: "An operator running machines for more than this in a day (from check-ins and engine time).", step: "0.5" },
  { name: "fatigueContinuousHours", label: "Operator hours without a break", help: "Running machines this long without a 15-minute break.", step: "0.5" },
] as const;

/** Speeding, idling and operator fatigue limits. Blank = off. */
export function SafetyForm({ current }: { current: Current }) {
  const [state, action, pending] = useActionState(saveSafetySettingsAction, { error: null, saved: false, version: 0 } as SettingsFormState);
  const value = (name: keyof Current) => state.values?.[name] ?? (current[name] === null ? "" : String(current[name]));
  return (
    <form key={state.version} action={action} className="space-y-3">
      {FIELDS.map((f) => (
        <label key={f.name} className="block text-sm">
          <span className="font-medium">{f.label}</span>
          <span className="block text-slate-500">{f.help}</span>
          <input
            name={f.name}
            type="number"
            step={f.step}
            min="0"
            defaultValue={value(f.name)}
            placeholder="Off"
            className="mt-1 w-32 rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
          />
        </label>
      ))}
      <p className="text-xs text-slate-500">Leave a box empty to turn that rule off. Subscribe to these on the Notifications page.</p>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.saved && <p className="text-sm text-emerald-700">Saved.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
