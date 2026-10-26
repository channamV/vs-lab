import Link from "next/link";
import { Suspense } from "react";
import { maintenanceHistory, maintenanceMachineChoices } from "@/lib/data";
import { machineLabel } from "@/lib/format";
import { HISTORY_RULES, historyQuery } from "@/lib/maintenance-queries";
import { SOURCES } from "@/lib/maintenance-types";
import { RANGE_PRESETS } from "@/lib/reports";
import { localDateKey } from "@/lib/telemetry/engine";
import { button, card, MaintenanceHeader, PriorityBadge, statusLabel } from "../ui";

/** Maintenance → History: every item opened in a date range (the machines' service record), with a CSV. */

type Params = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const field = "rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700";

export default function HistoryPage({ searchParams }: PageProps<"/maintenance/history">) {
  return (
    <div className="space-y-5">
      <Suspense fallback={<MaintenanceHeader active="/maintenance/history" canEdit={false} />}>
        <History searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function History({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const params = Object.fromEntries(["range", "from", "to", "machine", "status", "source", "page"].map((k) => [k, one(sp[k])]));
  const [{ rows, total, filters: f, timeZone }, machines] = await Promise.all([maintenanceHistory(params), maintenanceMachineChoices()]);
  const pages = Math.max(1, Math.ceil(total / HISTORY_RULES.pageSize));
  return (
    <>
      <MaintenanceHeader active="/maintenance/history" canEdit={false} />
      <form action="/maintenance/history" className={`${card} flex flex-wrap items-end gap-3 p-3 text-sm`}>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Opened</span>
          <select name="range" defaultValue={f.range.preset} className={field}>
            {Object.entries(RANGE_PRESETS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
            <option value="custom">Custom dates →</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">From (custom)</span>
          <input type="date" name="from" defaultValue={f.range.fromDate} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">To (custom)</span>
          <input type="date" name="to" defaultValue={f.range.toDate} className={field} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Machine</span>
          <select name="machine" defaultValue={f.machineId ?? ""} className={field}>
            <option value="">All machines</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {machineLabel(m)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Status</span>
          <select name="status" defaultValue={f.status} className={field}>
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="resolved">Resolved</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">From</span>
          <select name="source" defaultValue={f.source ?? ""} className={field}>
            <option value="">Anywhere</option>
            {Object.entries(SOURCES).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="rounded-lg bg-sky-700 px-4 py-1.5 font-medium text-white hover:bg-sky-800">Apply</button>
      </form>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {total.toLocaleString("en-CA")} item{total === 1 ? "" : "s"} opened {f.range.fromDate} to {f.range.toDate}
        </p>
        {total > 0 && (
          <a href={`/maintenance/history/export?${historyQuery(f)}`} className={button}>
            Download CSV
          </a>
        )}
      </div>
      {rows.length > 0 && (
        <ul className={`${card} divide-y divide-slate-100 dark:divide-slate-800`}>
          {rows.map((r) => (
            <li key={r.id}>
              <Link href={`/maintenance/issues/${r.id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm hover:bg-slate-50 dark:hover:bg-slate-800/50">
                <span className="w-14 font-mono text-xs text-slate-500">#{r.number}</span>
                <span className="w-24 text-slate-500 tabular-nums">{localDateKey(r.firstReportedAt.getTime(), timeZone)}</span>
                <PriorityBadge priority={r.priority} resolved={r.resolvedAt !== null} />
                <span className="min-w-0 flex-1 basis-48 font-medium">{r.title}</span>
                <span className="text-slate-500">{r.unitNumber ? `Unit ${r.unitNumber} · ${r.machineName}` : r.machineName}</span>
                <span className="text-xs text-slate-500">{statusLabel(r.status)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {f.page > 1 && (
            <Link href={`/maintenance/history?${historyQuery(f, { page: f.page - 1 })}`} className={button}>
              ← Newer
            </Link>
          )}
          <span className="text-slate-500">
            Page {f.page} of {pages}
          </span>
          {f.page < pages && (
            <Link href={`/maintenance/history?${historyQuery(f, { page: f.page + 1 })}`} className={button}>
              Older →
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
