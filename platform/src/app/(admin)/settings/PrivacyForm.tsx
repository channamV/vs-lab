"use client";

import { useActionState } from "react";
import { RETENTION_LIMITS, type RetentionKey } from "@/lib/privacy-limits";
import { savePrivacySettingsAction, type SettingsFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";

export function PrivacyForm({ current }: { current: { privacyContact: string | null } & Record<RetentionKey, number> }) {
  const [state, action, pending] = useActionState(savePrivacySettingsAction, { error: null, saved: false, version: 0 } as SettingsFormState);
  const value = (key: string, fallback: string) => state.values?.[key] ?? fallback;
  return (
    <form key={state.version} action={action} className="space-y-4">
      <label className="block text-sm">
        <span className="font-medium">Privacy contact</span>
        <span className="block text-slate-500">
          Shown to operators on the check-in page, for questions and requests about their data (e.g. privacy@yourcompany.com).
        </span>
        <input name="privacyContact" maxLength={200} defaultValue={value("privacyContact", current.privacyContact ?? "")} className={field} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">How long data is kept (days)</legend>
        <p className="text-sm text-slate-500">Older data is deleted automatically every night. 365 = 1 year.</p>
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-[1fr_8rem]">
          {(Object.keys(RETENTION_LIMITS) as RetentionKey[]).map((key) => (
            <label key={key} className="contents text-sm">
              <span className="self-center">
                {RETENTION_LIMITS[key].label}
                <span className="text-slate-500">
                  {" "}
                  ({RETENTION_LIMITS[key].min}–{RETENTION_LIMITS[key].max})
                </span>
              </span>
              <input
                name={key}
                type="number"
                required
                min={RETENTION_LIMITS[key].min}
                max={RETENTION_LIMITS[key].max}
                defaultValue={value(key, String(current[key]))}
                className={field}
              />
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
