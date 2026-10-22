"use client";

import { useActionState } from "react";
import { saveScanSettingsAction, type PlanFormState } from "./actions";

/** Scan to fill: keep the scanned certificate with the record by default (on unless the owner turns it off). */
export function ScanSettingsForm({ retain }: { retain: boolean }) {
  const [state, action, pending] = useActionState(saveScanSettingsAction, { error: null, saved: false, version: 0 } as PlanFormState);
  return (
    <form action={action} className="space-y-3 text-sm">
      <label className="flex items-start gap-2">
        <input type="checkbox" name="retainScanImages" defaultChecked={retain} className="mt-1" />
        <span>
          <span className="font-medium">Retain images after processing</span>
          <span className="block text-slate-500">
            When a certificate is scanned, keep the photo with the training record. Untick to keep only the details read from it.
            Managers can still choose for each scan.
          </span>
        </span>
      </label>
      {state.saved && <p className="text-emerald-700">Saved.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
