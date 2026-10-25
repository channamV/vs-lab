"use client";

import { useActionState } from "react";
import { TIMEZONES } from "@/lib/schedule-time";
import { saveScheduleSettingsAction, type PlanFormState } from "./actions";

const RULES = {
  least_restrictive: "Least restrictive wins (Unlocked, then Access-Controlled, then Locked): work isn't blocked by accident",
  most_restrictive: "Most restrictive wins (Locked, then Access-Controlled, then Unlocked)",
};

/** Company time zone (owners) and, for Veristart staff, the schedule conflict rule. */
export function ScheduleSettingsForm({ timezone, rule, staff }: { timezone: string; rule: keyof typeof RULES; staff: boolean }) {
  const [state, action, pending] = useActionState(saveScheduleSettingsAction, { error: null, saved: false, version: 0 } as PlanFormState);
  const zones = TIMEZONES.some((t) => t.value === timezone) ? TIMEZONES : [...TIMEZONES, { value: timezone, label: timezone }];
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="block">
        <span className="font-medium">Company time zone</span>
        <span className="block text-slate-500">
          All times and days in VS Lab use it (pages, alerts, reports, daily limits). It's also the default for new
          schedules; each schedule can still use its own.
        </span>
        <select name="timezone" defaultValue={timezone} className="mt-1 rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700">
          {zones.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label} ({t.value})
            </option>
          ))}
        </select>
      </label>
      <label className="block">
        <span className="font-medium">When schedules disagree</span>
        {staff ? (
          <select name="conflictRule" defaultValue={rule} className="mt-1 block w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700">
            {Object.entries(RULES).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        ) : (
          <span className="block text-slate-600 dark:text-slate-400">{RULES[rule]}. Ask Veristart to change this.</span>
        )}
        <span className="block text-xs text-slate-500">Temporary overrides always beat regular schedules; scheduled operator access beats a scheduled Locked.</span>
      </label>
      {state.error && <p className="text-red-600">{state.error}</p>}
      {state.saved && <p className="text-emerald-700">Saved.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
