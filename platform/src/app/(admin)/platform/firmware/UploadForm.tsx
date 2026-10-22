"use client";

import { useActionState } from "react";
import { uploadFirmwareAction, type UploadState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";

/** Upload a firmware build: version, what changed, and the .bin file. */
export function UploadForm() {
  const [state, action, pending] = useActionState(uploadFirmwareAction, { error: null, version: 0 } as UploadState);
  return (
    <form key={state.version} action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Version</span>
          <input name="version" required maxLength={40} placeholder="e.g. vs-1.0.3" defaultValue={state.values?.version} className={field} />
          <span className="text-xs text-slate-500">Exactly as the firmware reports it (FW=), so devices running it are recognised.</span>
        </label>
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Firmware file (.bin)</span>
          <input name="file" type="file" accept=".bin,application/octet-stream" required className={`${field} text-sm`} />
        </label>
      </div>
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">What changed (optional)</span>
        <textarea name="notes" rows={2} maxLength={1000} defaultValue={state.values?.notes} className={field} />
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Uploading…" : "Upload release"}
      </button>
    </form>
  );
}
