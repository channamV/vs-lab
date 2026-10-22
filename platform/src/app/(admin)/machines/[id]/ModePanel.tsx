"use client";

import { useActionState, useState } from "react";
import { MODES, modeMeaning, modesFor, type Mode } from "@/lib/mode-types";
import { setModeAction, setOfflineFallbackAction, type ModeFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const COLOURS: Record<Mode, string> = {
  access_controlled: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  unlocked: "bg-amber-100 text-amber-900 dark:bg-amber-900/40 dark:text-amber-200",
  locked: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
};

export function ModeBadge({ mode }: { mode: Mode }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${COLOURS[mode]}`}>{MODES[mode].label}</span>;
}

export type ModePanelProps = {
  machineId: number;
  tier: "gps" | "monitor" | "control";
  mode: Mode;
  /** Plain-language status lines, worked out on the server (time zone). */
  status: string[];
  safetyLocked: boolean;
  canChange: boolean;
  offlineMode: Mode | null;
  offlineAfterHours: number;
  history: { at: string; text: string }[];
};

/** The machine's operating mode: what it is, change it (now or for a while), offline fallback, history. */
export function ModePanel(p: ModePanelProps) {
  const [state, action, pending] = useActionState(setModeAction, { error: null, version: 0 } as ModeFormState);
  const [offline, offlineAction, offlinePending] = useActionState(setOfflineFallbackAction, { error: null, version: 0 } as ModeFormState);
  const options = modesFor(p.tier);
  const [mode, setMode] = useState<Mode>(options.find((m) => m !== p.mode) ?? options[0]);
  const [duration, setDuration] = useState("indefinite");

  return (
    <div className="space-y-3 text-sm">
      <p>
        <ModeBadge mode={p.mode} /> {p.safetyLocked ? "Locked out for repair (see below)." : modeMeaning(p.mode, p.tier)}
      </p>
      {p.status.map((s) => (
        <p key={s} className="text-slate-600 dark:text-slate-400">
          {s}
        </p>
      ))}

      {p.canChange && !p.safetyLocked && (
        <form key={state.version} action={action} className="space-y-2 rounded border border-slate-200 p-3 dark:border-slate-800">
          <input type="hidden" name="id" value={p.machineId} />
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="text-slate-600 dark:text-slate-400">Change to</span>
              <select name="mode" value={mode} onChange={(e) => setMode(e.target.value as Mode)} className={field}>
                {options.map((m) => (
                  <option key={m} value={m}>
                    {MODES[m].label}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-slate-600 dark:text-slate-400">For</span>
              <select name="duration" value={duration} onChange={(e) => setDuration(e.target.value)} className={field}>
                <option value="indefinite">Until changed again</option>
                <option value="1h">1 hour</option>
                <option value="4h">4 hours</option>
                <option value="8h">8 hours</option>
                <option value="morning">Until 6 AM</option>
                <option value="until">Until a date and time…</option>
              </select>
            </label>
          </div>
          {duration === "until" && <input type="datetime-local" name="until" required className={field} />}
          <p className="text-xs text-slate-500">{modeMeaning(mode, p.tier)}</p>
          {duration !== "indefinite" && <p className="text-xs text-slate-500">Then it goes back to {MODES[p.mode].label}.</p>}
          <input name="reason" maxLength={300} placeholder="Reason (optional), e.g. mechanic visit, weekend" className={field} />
          {state.error && <p className="text-red-600">{state.error}</p>}
          <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 font-medium text-white hover:bg-sky-800 disabled:opacity-50">
            {pending ? "Changing…" : `Set ${MODES[mode].label}`}
          </button>
        </form>
      )}

      {p.canChange && (
        <details className="rounded border border-slate-200 p-3 dark:border-slate-800">
          <summary className="cursor-pointer">
            When offline:{" "}
            <span className="font-medium">
              {p.offlineMode ? `${MODES[p.offlineMode].label} after ${p.offlineAfterHours} h` : "keep the current mode"}
            </span>
          </summary>
          <form key={offline.version} action={offlineAction} className="mt-2 space-y-2">
            <input type="hidden" name="id" value={p.machineId} />
            <p className="text-xs text-slate-500">
              Machines with an ignition relay (Safety &amp; Access Control) decide for themselves when they can&apos;t reach us. Choose
              what happens after a long time without a connection: keep the mode (most secure; a Locked machine stays locked and a new
              operator can&apos;t be added), or switch, e.g. to Unlocked so crews aren&apos;t stranded. A machine locked out for repair
              always stays locked.
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block">
                <span className="text-slate-600 dark:text-slate-400">Switch to</span>
                <select name="offlineMode" defaultValue={p.offlineMode ?? ""} className={field}>
                  <option value="">Keep the current mode</option>
                  {options.map((m) => (
                    <option key={m} value={m}>
                      {MODES[m].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="text-slate-600 dark:text-slate-400">After (hours without a connection)</span>
                <input name="offlineAfterHours" type="number" min={1} max={168} defaultValue={p.offlineAfterHours} className={field} />
              </label>
            </div>
            {offline.error && <p className="text-red-600">{offline.error}</p>}
            <button disabled={offlinePending} className="rounded border border-slate-300 px-3 py-1.5 hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800">
              {offlinePending ? "Saving…" : "Save"}
            </button>
          </form>
        </details>
      )}

      {p.history.length > 0 && (
        <details>
          <summary className="cursor-pointer text-slate-600 dark:text-slate-400">Recent changes</summary>
          <ul className="mt-1 space-y-1 text-xs text-slate-600 dark:text-slate-400">
            {p.history.map((h) => (
              <li key={h.at + h.text}>
                <span className="text-slate-500">{h.at}</span> · {h.text}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
