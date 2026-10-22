import Link from "next/link";
import { Suspense } from "react";
import { requestTime, schedulesData } from "@/lib/data";
import { MODES, type Mode } from "@/lib/mode-types";
import {
  ACTION_LABEL,
  findConflicts,
  fmtDate,
  fmtInstant,
  occurrences,
  RECURRENCE_LABEL,
  scheduleState,
  summarizeSchedule,
  tzShort,
  type Recurrence,
  type ScheduleAction,
} from "@/lib/schedule-time";
import { deleteScheduleAction, setScheduleStatusAction } from "./actions";

const card = "rounded-xl border border-slate-300 bg-white dark:border-slate-700 dark:bg-slate-900";
const STATE_STYLE: Record<string, string> = {
  "In effect": "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  Scheduled: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300",
  Paused: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  Completed: "bg-slate-100 text-slate-500 dark:bg-slate-800",
  "No upcoming runs": "bg-slate-100 text-slate-500 dark:bg-slate-800",
};

/** Schedules (Jira V1-267): automatic mode changes and temporary operator access, with the next 7 days. */
export default function SchedulesPage({ searchParams }: PageProps<"/schedules">) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Schedules</h1>
        <p className="text-sm text-slate-500">
          Lock machines every night and weekend, unlock them for a job, or give a subcontractor access for a week. Schedules make the same
          changes you could make by hand, at the right local time.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading schedules…</p>}>
        <Schedules searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

type Filter = "all" | "active" | "paused" | "conflicts";

async function Schedules({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [data, now, sp] = await Promise.all([schedulesData(), requestTime(), searchParams]);
  const filter = (["all", "active", "paused", "conflicts"].includes(String(sp.filter)) ? sp.filter : "all") as Filter;
  const names = {
    machines: new Map(data.machineNames.map((m) => [m.id, m.name])),
    operators: new Map(data.operators.map((o) => [o.id, o.name])),
    allMachines: data.machineNames.map((m) => m.id),
  };
  const conflicts = new Map(
    data.schedules.map((s) => [s.id, s.status === "active" ? findConflicts(s, data.schedules, names, data.conflictRule, now).filter((c) => c.severity !== "info") : []]),
  );
  const visible = data.schedules.filter(
    (s) => filter === "all" || (filter === "conflicts" ? conflicts.get(s.id)!.length > 0 : s.status === filter),
  );
  const count = (f: Filter) => (f === "all" ? data.schedules.length : f === "conflicts" ? data.schedules.filter((s) => conflicts.get(s.id)!.length).length : data.schedules.filter((s) => s.status === f).length);
  const tz = data.fleetTimezone;

  // Upcoming: the next 7 days of changes from active schedules, in the fleet timezone.
  const until = now + 7 * 86_400_000;
  const timeline = data.schedules
    .filter((s) => s.status === "active")
    .flatMap((s) => {
      const target = s.machineIds.length ? `${s.machineIds.length} machine${s.machineIds.length === 1 ? "" : "s"}` : "All machines";
      const who = `${s.operatorIds.length} operator${s.operatorIds.length === 1 ? "" : "s"}`;
      return occurrences(s, now, 8).flatMap((o) => {
        const items: { at: number; text: string; kind: "Starts" | "Ends"; s: typeof s }[] = [];
        if (o.start > now && o.start <= until)
          items.push({ at: o.start, kind: "Starts", s, text: s.action === "machine_mode" ? `${target} → ${MODES[s.mode as Mode]?.label}` : `Give ${who} access to ${target.toLowerCase()}` });
        if (o.end !== null && o.end > now && o.end <= until)
          items.push({
            at: o.end,
            kind: "Ends",
            s,
            text:
              s.action === "machine_mode"
                ? `${target} ${s.endBehavior === "set_mode" && s.endMode ? `→ ${MODES[s.endMode as Mode]?.label}` : "→ previous mode"}`
                : `Remove access for ${who} on ${target.toLowerCase()}`,
          });
        return items;
      });
    })
    .sort((a, b) => a.at - b.at)
    .slice(0, 40);
  const live = data.schedules.filter((s) => scheduleState(s, now).label === "In effect").length;
  const dayOf = (at: number) => fmtInstant(at, tz, { weekday: "long", month: "short", day: "numeric" });

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_380px]">
      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 p-4 dark:border-slate-800">
          <div>
            <h2 className="font-semibold">All schedules</h2>
            <p className="text-xs text-slate-500">
              Each runs in its own timezone · fleet default {tzShort(tz, now)} · when schedules disagree: {data.conflictRule === "most_restrictive" ? "most" : "least"} restrictive wins
            </p>
          </div>
          {data.actions.length > 0 && (
            <Link href="/schedules/new" className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
              + New schedule
            </Link>
          )}
        </div>
        <nav className="flex flex-wrap gap-2 border-b border-slate-200 px-4 py-3 text-sm dark:border-slate-800">
          {(["all", "active", "paused", "conflicts"] as Filter[]).map((f) => (
            <Link
              key={f}
              href={f === "all" ? "/schedules" : `/schedules?filter=${f}`}
              className={`rounded-full border px-3 py-1 ${filter === f ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 dark:border-slate-700"}`}
            >
              {{ all: "All", active: "Active", paused: "Paused", conflicts: "Conflicts & overlaps" }[f]} ({count(f)})
            </Link>
          ))}
        </nav>
        {visible.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">{data.schedules.length ? "No schedules match this filter." : "No schedules yet."}</p>
        ) : (
          <ul className="divide-y divide-slate-200 dark:divide-slate-800">
            {visible.map((s) => {
              const state = scheduleState(s, now);
              const list = conflicts.get(s.id)!;
              const hard = list.filter((c) => c.severity === "conflict");
              const soft = list.filter((c) => c.severity !== "conflict");
              return (
                <li key={s.id} className={`p-4 ${s.status === "paused" ? "bg-slate-50/60 dark:bg-slate-950/40" : ""}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2">
                        <Link href={`/schedules/${s.id}`} className="font-semibold hover:underline">
                          {s.name}
                        </Link>
                        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATE_STYLE[state.label]}`}>{state.label}</span>
                      </p>
                      <p className="mt-1 flex flex-wrap gap-1.5 text-xs">
                        <span className="rounded border border-slate-300 px-2 py-0.5 dark:border-slate-700">
                          {s.action === "machine_mode" ? "🔒" : "🔑"} {ACTION_LABEL[s.action as ScheduleAction]}
                        </span>
                        <span className="rounded border border-slate-300 px-2 py-0.5 dark:border-slate-700">📅 {RECURRENCE_LABEL[s.recurrence as Recurrence]}</span>
                      </p>
                      <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                        {summarizeSchedule(s, names)} <span className="text-xs text-slate-500">{tzShort(s.timezone, now)}</span>
                      </p>
                      <p className="text-xs text-slate-500">
                        {state.label === "In effect" && state.current && (state.current.end === null ? "In effect until changed by hand" : `In effect until ${fmtInstant(state.current.end, s.timezone)}`)}
                        {state.label === "Scheduled" && state.next && `Next: ${fmtInstant(state.next.start, s.timezone)}`}
                        {state.label === "Paused" && (state.next ? `Paused: would next run ${fmtInstant(state.next.start, s.timezone)}` : "Paused")}
                        {state.label === "Completed" && `Ended ${fmtDate(s.endDate)}`}
                      </p>
                      {hard.map((c) => (
                        <p key={c.otherId} className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1 text-xs text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
                          ⚠ Conflicts with{" "}
                          <Link href={`/schedules/${c.otherId}`} className="font-semibold underline">
                            {c.otherName}
                          </Link>{" "}
                          from {fmtInstant(c.window.start, s.timezone, { weekday: "short", month: "short", day: "numeric" })}. {c.resolution}
                        </p>
                      ))}
                      {soft.length > 0 && (
                        <p className="mt-2 text-xs text-amber-800 dark:text-amber-300" title={soft.map((c) => c.message).join("\n")}>
                          {soft.length} notice{soft.length === 1 ? "" : "s"}: {soft.map((c) => c.otherName).join(", ")}
                        </p>
                      )}
                      <p className="mt-1 text-xs text-slate-400">By {s.createdBy}</p>
                    </div>
                    {s.canManage && (
                      <div className="flex shrink-0 flex-wrap items-center gap-1 text-sm">
                        {state.label !== "Completed" && (
                          <form action={setScheduleStatusAction}>
                            <input type="hidden" name="id" value={s.id} />
                            <input type="hidden" name="status" value={s.status === "active" ? "paused" : "active"} />
                            <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                              {s.status === "active" ? "Pause" : "Activate"}
                            </button>
                          </form>
                        )}
                        <Link href={`/schedules/${s.id}`} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                          Edit
                        </Link>
                        <Link href={`/schedules/new?duplicate=${s.id}`} className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                          Duplicate
                        </Link>
                        <details className="relative">
                          <summary className="cursor-pointer list-none rounded border border-red-300 px-2 py-1 text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
                            Delete
                          </summary>
                          <form action={deleteScheduleAction} className="absolute right-0 z-10 mt-1 w-64 space-y-2 rounded-lg border border-slate-300 bg-white p-3 text-xs shadow-lg dark:border-slate-700 dark:bg-slate-900">
                            <input type="hidden" name="id" value={s.id} />
                            <p>
                              {state.label === "In effect"
                                ? "This schedule is in effect now. Deleting it ends it straight away and applies its end behaviour."
                                : "Delete this schedule? This can't be undone."}
                            </p>
                            <button className="rounded bg-red-700 px-2 py-1 font-medium text-white hover:bg-red-800">Delete schedule</button>
                          </form>
                        </details>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside className={`${card} self-start`}>
        <div className="border-b border-slate-200 p-4 dark:border-slate-800">
          <h2 className="font-semibold">📅 Upcoming</h2>
          <p className="text-xs text-slate-500">Next 7 days · active schedules · {tzShort(tz, now)}</p>
        </div>
        <div className="grid grid-cols-3 border-b border-slate-200 text-center text-xs dark:border-slate-800">
          <div className="p-3">
            <b className="block text-lg text-emerald-700 dark:text-emerald-400">{live}</b>In effect
          </div>
          <div className="p-3">
            <b className="block text-lg text-sky-700 dark:text-sky-400">{timeline.filter((t) => t.at <= now + 86_400_000).length}</b>Next 24 h
          </div>
          <div className="p-3">
            <b className={`block text-lg ${count("conflicts") ? "text-red-700 dark:text-red-400" : ""}`}>{data.schedules.filter((s) => conflicts.get(s.id)!.some((c) => c.severity === "conflict")).length}</b>
            Conflicts
          </div>
        </div>
        {timeline.length === 0 ? (
          <p className="p-8 text-center text-sm text-slate-500">Nothing scheduled in the next 7 days.</p>
        ) : (
          <ul className="max-h-[70vh] overflow-y-auto text-sm">
            {timeline.map((t, i) => {
              const day = dayOf(t.at);
              const header = i === 0 || dayOf(timeline[i - 1].at) !== day ? day : null;
              return (
                <li key={`${t.s.id}-${t.kind}-${t.at}`}>
                  {header && <p className="border-b border-slate-200 bg-slate-50 px-4 py-1.5 text-xs font-semibold uppercase text-slate-500 dark:border-slate-800 dark:bg-slate-950">{header}</p>}
                  <div className="flex gap-3 border-b border-slate-100 px-4 py-2 dark:border-slate-800">
                    <span className="w-16 shrink-0 text-xs font-semibold">{fmtInstant(t.at, tz, { hour: "numeric", minute: "2-digit" })}</span>
                    <span className="min-w-0">
                      <span className={t.kind === "Ends" ? "text-slate-500" : ""}>{t.text}</span>
                      <span className="block text-xs text-slate-500">
                        {t.kind} · {t.s.name}
                      </span>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </aside>
    </div>
  );
}
