import Link from "next/link";
import { Suspense } from "react";
import { maintenanceOverview } from "@/lib/data";
import { PRIORITIES, type Priority } from "@/lib/maintenance-types";
import { card, IssueChip, MaintenanceHeader, PriorityBadge } from "./ui";

/**
 * Maintenance → By machine (docs/maintenance.md): every machine with open work or a service coming due, worst first.
 * Built for a mechanic's phone: one column of cards, big tap targets.
 */

type Params = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function MaintenancePage({ searchParams }: PageProps<"/maintenance">) {
  return (
    <div className="space-y-5">
      <Suspense fallback={<MaintenanceHeader active="/maintenance" canEdit={false} />}>
        <ByMachine searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function ByMachine({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const { cards, kpis, worksites, worksiteId, canEdit } = await maintenanceOverview({ worksite: one(sp.worksite) });
  return (
    <>
      <MaintenanceHeader active="/maintenance" canEdit={canEdit} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <Kpi label="Open items" value={String(kpis.open)} />
        <Kpi label="Machines with items" value={String(kpis.machines)} />
        <Kpi label="Average age" value={kpis.avgAgeDays === null ? "—" : `${Math.round(kpis.avgAgeDays)} days`} />
        <Kpi label="Resolved (7 days)" value={String(kpis.resolved7d)} />
      </div>
      {kpis.byPriority.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {kpis.byPriority.map(([p, n]) => (
            <span key={p} className={`rounded-full px-2.5 py-1 text-xs font-medium ${PRIORITIES[p as Priority]?.style ?? ""}`}>
              {PRIORITIES[p as Priority]?.label ?? p}: {n}
            </span>
          ))}
          {kpis.oldest && kpis.oldest.days > 0 && (
            <Link href={`/maintenance/issues/${kpis.oldest.id}`} className="rounded-full px-2.5 py-1 text-xs text-slate-600 underline dark:text-slate-400">
              Oldest: #{kpis.oldest.number}, {kpis.oldest.days} days
            </Link>
          )}
        </div>
      )}

      {worksites.length > 0 && (
        <form action="/maintenance" className="flex items-center gap-2 text-sm">
          <label htmlFor="worksite" className="text-slate-500">
            Worksite
          </label>
          <select id="worksite" name="worksite" defaultValue={worksiteId ?? ""} className="rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700">
            <option value="">All machines</option>
            {worksites.map((w) => (
              <option key={w.id} value={w.id}>
                At {w.name} now
              </option>
            ))}
          </select>
          <button className="rounded-lg border border-slate-300 px-3 py-1.5 dark:border-slate-700">Show</button>
        </form>
      )}

      {cards.length === 0 ? (
        <div className={`${card} space-y-1 p-8 text-center`}>
          <p className="text-3xl" aria-hidden>
            🔧
          </p>
          <p className="font-medium">Nothing outstanding.</p>
          <p className="text-sm text-slate-500">All machines are clear. New work appears here as it comes in: checklist defects, services coming due, devices offline.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {cards.map((m) => (
            <section key={m.id} className={`${card} space-y-3 p-4`}>
              <div className="flex items-start justify-between gap-2">
                <Link href={`/machines/${m.id}`} className="min-w-0 font-semibold hover:underline">
                  {m.label}
                </Link>
                {m.worst && <PriorityBadge priority={m.worst} />}
              </div>
              {m.lockedOut && <p className="rounded-lg bg-red-50 px-3 py-1.5 text-sm font-medium text-red-800 dark:bg-red-950 dark:text-red-300">🔒 Locked out for repair</p>}
              {m.issues.length > 0 && (
                <div className="space-y-1.5">
                  {m.issues.map((i) => (
                    <IssueChip key={i.id} issue={i} />
                  ))}
                </div>
              )}
              {m.services.length > 0 && (
                <ul className="space-y-1 text-sm">
                  {m.services.map((s) => (
                    <li key={s.scheduleId} className={s.state === "due" ? "font-medium text-sky-800 dark:text-sky-300" : "text-slate-600 dark:text-slate-400"}>
                      🛠️ {s.description}: {s.state === "due" ? `due (${s.text})` : `due soon (${s.text})`}
                    </li>
                  ))}
                </ul>
              )}
              <p className="border-t border-slate-100 pt-2 text-xs text-slate-500 dark:border-slate-800">
                {m.issues.length} open · {m.resolvedToday} resolved today
              </p>
            </section>
          ))}
        </div>
      )}
    </>
  );
}

function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <div className={`${card} p-3`}>
      <p className="text-xs text-slate-500">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}
