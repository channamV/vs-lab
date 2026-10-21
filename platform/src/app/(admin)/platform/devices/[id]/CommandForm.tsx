"use client";

import { useActionState, useState } from "react";
import { queueCommandAction, type CommandFormState } from "../../actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";

/** Pick a command and its values; it's queued for the device's next contact. */
export function CommandForm({ deviceId, commands }: { deviceId: string; commands: { kind: string; label: string; help: string }[] }) {
  const [state, action, pending] = useActionState(queueCommandAction, { error: null, queued: false, version: 0 } as CommandFormState);
  const [kind, setKind] = useState(commands[0].kind);
  const help = commands.find((c) => c.kind === kind)?.help;
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="deviceId" value={deviceId} />
      <div className="grid gap-3 sm:grid-cols-[16rem_1fr]">
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Command</span>
          <select name="kind" value={kind} onChange={(e) => setKind(e.target.value)} className={field}>
            {commands.map((c) => (
              <option key={c.kind} value={c.kind}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          {kind === "buzzer" && (
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-400">Times</span>
              <input name="times" type="number" min={1} max={10} defaultValue={3} className={field} />
            </label>
          )}
          {kind === "rate" && (
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-400">Seconds between reports</span>
              <input name="seconds" type="number" min={1} max={60} defaultValue={5} required className={field} />
            </label>
          )}
          {kind === "wifi" && (
            <>
              <label className="block text-sm">
                <span className="text-slate-600 dark:text-slate-400">Network name (SSID)</span>
                <input name="ssid" maxLength={32} required className={field} />
              </label>
              <label className="block text-sm">
                <span className="text-slate-600 dark:text-slate-400">Password</span>
                <input name="password" type="password" maxLength={63} autoComplete="off" className={field} />
              </label>
            </>
          )}
        </div>
      </div>
      {help && <p className="text-xs text-slate-500">{help}</p>}
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.queued && <p className="text-sm text-emerald-700">Queued: it goes out with the device&apos;s next report or check-in.</p>}
      <button disabled={pending} className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50">
        {pending ? "Queuing…" : "Send command"}
      </button>
    </form>
  );
}
