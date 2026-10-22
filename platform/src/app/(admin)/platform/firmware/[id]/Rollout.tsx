"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { sendUpdateAction, type RolloutState } from "../actions";

export type RolloutDevice = {
  id: string;
  firmwareVersion: string | null;
  lastSeen: string;
  where: string;
  organization: string;
  update: { state: string; at: string; result: string | null } | null;
};

const STATE_LABELS: Record<string, string> = {
  waiting: "Waiting for the device",
  sent: "Sent, installing",
  done: "Updated",
  failed: "Failed",
  expired: "Expired (device didn't answer)",
  cancelled: "Cancelled",
};
const STATE_COLOURS: Record<string, string> = {
  done: "text-emerald-700 dark:text-emerald-400",
  failed: "text-red-700 dark:text-red-400",
  expired: "text-red-700 dark:text-red-400",
};

/** Device list with ticks: pick a stage (a bench device, some pilots, everyone left) and send. */
export function Rollout({ releaseId, version, devices, retired }: { releaseId: number; version: string; devices: RolloutDevice[]; retired: boolean }) {
  const [state, action, pending] = useActionState(sendUpdateAction, { error: null, message: null, version: 0 } as RolloutState);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [org, setOrg] = useState("");
  const orgs = useMemo(() => [...new Set(devices.map((d) => d.organization))].sort(), [devices]);
  const shown = devices.filter((d) => !org || d.organization === org);
  const eligible = (d: RolloutDevice) => d.firmwareVersion !== version && d.update?.state !== "waiting" && d.update?.state !== "sent";
  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const button = "rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800";

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="releaseId" value={releaseId} />
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select value={org} onChange={(e) => setOrg(e.target.value)} className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700">
          <option value="">All organizations</option>
          {orgs.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
        <button type="button" className={button} onClick={() => setSelected(new Set(shown.filter(eligible).map((d) => d.id)))}>
          Tick all shown not on {version}
        </button>
        <button type="button" className={button} onClick={() => setSelected(new Set())}>
          Clear
        </button>
        <span className="text-slate-500">{selected.size} ticked</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs uppercase text-slate-500">
            <tr>
              <th className="w-8 py-1"></th>
              <th className="py-1 pr-3">Device</th>
              <th className="py-1 pr-3">Where</th>
              <th className="py-1 pr-3">Running</th>
              <th className="py-1 pr-3">Last report</th>
              <th className="py-1 pr-3">This update</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id} className="border-t border-slate-100 dark:border-slate-800">
                <td className="py-2">
                  {selected.has(d.id) && <input type="hidden" name="deviceId" value={d.id} />}
                  <input
                    type="checkbox"
                    aria-label={`Send to ${d.id}`}
                    checked={selected.has(d.id)}
                    disabled={!eligible(d) || retired}
                    onChange={() => toggle(d.id)}
                  />
                </td>
                <td className="py-2 pr-3">
                  <Link href={`/platform/devices/${encodeURIComponent(d.id)}`} className="font-mono text-sky-700 hover:underline dark:text-sky-400">
                    {d.id}
                  </Link>
                </td>
                <td className="py-2 pr-3">{d.where}</td>
                <td className="py-2 pr-3 font-mono text-xs">{d.firmwareVersion ?? <span className="font-sans text-slate-500">not reported (stock?)</span>}</td>
                <td className="py-2 pr-3 text-slate-500">{d.lastSeen}</td>
                <td className={`py-2 pr-3 ${d.update ? (STATE_COLOURS[d.update.state] ?? "") : "text-slate-500"}`}>
                  {d.update ? STATE_LABELS[d.update.state] ?? d.update.state : "—"}
                  {d.update?.result && <div className="text-xs text-slate-500">{d.update.result}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {state.message && <p className="text-sm text-emerald-700">{state.message}</p>}
      {!retired && (
        <button
          disabled={pending || selected.size === 0}
          onClick={() => setTimeout(() => setSelected(new Set()), 0)}
          className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {pending ? "Queuing…" : `Send ${version} to ${selected.size} device${selected.size === 1 ? "" : "s"}`}
        </button>
      )}
    </form>
  );
}
