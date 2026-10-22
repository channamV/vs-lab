import Link from "next/link";
import { Suspense } from "react";
import { reportData, requestTime } from "@/lib/data";
import { clockTime, formatHours, machineLabel, timeAgo } from "@/lib/format";
import { IDLE_SOURCE_LABELS, isMeasuredIdle, RANGE_PRESETS, REPORT_RULES, type Report } from "@/lib/reports";
import { WORKSITE_TYPES, worksiteColor, type WorksiteType } from "@/lib/worksite-types";
import { SAFETY_KINDS, type SafetyKind } from "@/lib/safety-kinds";
import { ActivityHeatmap, DailyHoursChart, HoursBars, Meter, dayLabel } from "./charts";

/**
 * Reports: equipment use, operators, pre-start checklist compliance and worksites, for a date range.
 * Filters live in the URL (?range=7d&division=…&tab=…), so a report can be bookmarked or shared.
 */

const TABS = {
  overview: "Overview",
  machines: "Machines",
  operators: "Operators",
  compliance: "Checklist compliance",
  fuel: "Fuel",
  safety: "Safety",
  worksites: "Worksites",
} as const;
type Tab = keyof typeof TABS;
type Params = { [key: string]: string | string[] | undefined };

const card = "rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
const th = "px-3 py-2 font-medium";
const td = "px-3 py-2 tabular-nums";
const pct = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) ? "—" : `${Math.round(n * 100)}%`);

export default function ReportsPage({ searchParams }: PageProps<"/reports">) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Reports</h1>
        <p className="text-sm text-slate-500">Engine hours, idle time, utilization, operators, checklist compliance, fuel, safety and worksites.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Working out the report…</p>}>
        <Reports searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

async function Reports({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const params = { range: one(sp.range), from: one(sp.from), to: one(sp.to), division: one(sp.division) };
  const tab: Tab = (one(sp.tab) ?? "") in TABS ? (one(sp.tab) as Tab) : "overview";
  const [{ report, divisions, divisionId, timeZone }, now] = await Promise.all([reportData(params), requestTime()]);
  const qs = (changes: Record<string, string | null>) => {
    const q = new URLSearchParams();
    const merged = { range: report.range.preset, from: report.range.fromDate, to: report.range.toDate, division: divisionId ? String(divisionId) : null, tab, ...changes };
    for (const [k, v] of Object.entries(merged)) {
      if (!v || (k === "tab" && v === "overview")) continue;
      if ((k === "from" || k === "to") && merged.range !== "custom") continue;
      q.set(k, v);
    }
    return q.toString();
  };
  const query = (changes: Record<string, string | null>) => (qs(changes) ? `?${qs(changes)}` : "");
  const csv = (kind: string) => `/reports/export?${[qs({ tab: null }), `report=${kind}`].filter(Boolean).join("&")}`;

  return (
    <>
      <Filters report={report} divisions={divisions} divisionId={divisionId} tab={tab} query={query} timeZone={timeZone} />
      <nav className="flex flex-wrap gap-1 border-b border-slate-200 dark:border-slate-800" aria-label="Report">
        {(Object.keys(TABS) as Tab[]).map((t) => (
          <Link
            key={t}
            href={`/reports${query({ tab: t })}`}
            aria-current={t === tab ? "page" : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              t === tab ? "border-sky-700 font-medium text-sky-800 dark:border-sky-400 dark:text-sky-300" : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            {TABS[t]}
          </Link>
        ))}
      </nav>
      {report.machines.length === 0 ? (
        <p className={`${card} p-6 text-sm text-slate-500`}>No machines to report on.</p>
      ) : tab === "overview" ? (
        <Overview report={report} />
      ) : tab === "machines" ? (
        <Machines report={report} csv={csv("machines")} now={now} />
      ) : tab === "operators" ? (
        <Operators report={report} csv={csv("operators")} />
      ) : tab === "compliance" ? (
        <Compliance report={report} csv={csv("compliance")} />
      ) : tab === "fuel" ? (
        <Fuel report={report} csv={csv("fuel")} logCsv={csv("fuel-log")} timeZone={timeZone} now={now} />
      ) : tab === "safety" ? (
        <Safety report={report} csv={csv("safety")} timeZone={timeZone} now={now} />
      ) : (
        <Worksites report={report} csv={csv("worksites")} />
      )}
    </>
  );
}

function Filters({
  report,
  divisions,
  divisionId,
  tab,
  query,
  timeZone,
}: {
  report: Report;
  divisions: { id: number; name: string }[];
  divisionId: number | null;
  tab: Tab;
  query: (changes: Record<string, string | null>) => string;
  timeZone: string;
}) {
  const chip = (on: boolean) =>
    `rounded-full border px-3 py-1 text-sm ${
      on ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
    }`;
  const field = "rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {Object.entries(RANGE_PRESETS).map(([key, label]) => (
        <Link key={key} href={`/reports${query({ range: key })}`} className={chip(report.range.preset === key)}>
          {label}
        </Link>
      ))}
      <form action="/reports" className="flex flex-wrap items-center gap-1 text-sm">
        <input type="hidden" name="range" value="custom" />
        {tab !== "overview" && <input type="hidden" name="tab" value={tab} />}
        {divisionId && <input type="hidden" name="division" value={divisionId} />}
        <input type="date" name="from" defaultValue={report.range.fromDate} aria-label="From" className={field} />
        <span className="text-slate-500">to</span>
        <input type="date" name="to" defaultValue={report.range.toDate} aria-label="To" className={field} />
        <button className={chip(report.range.preset === "custom")}>Apply</button>
      </form>
      {divisions.length > 0 && (
        <form action="/reports" className="flex items-center gap-1 text-sm">
          {Object.entries({ range: report.range.preset, ...(report.range.preset === "custom" ? { from: report.range.fromDate, to: report.range.toDate } : {}), ...(tab !== "overview" ? { tab } : {}) }).map(
            ([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ),
          )}
          <select name="division" defaultValue={divisionId ?? ""} aria-label="Division" className={field}>
            <option value="">All divisions</option>
            {divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
          <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Show</button>
        </form>
      )}
      <span className="ml-auto text-xs text-slate-500">
        {report.range.label} · {timeZone.replace("_", " ")}
      </span>
    </div>
  );
}

const IDLE_HELP =
  `Best source first: the engine computer's own idle meter (J1939); else engine running below ${REPORT_RULES.idleRpm} rpm; ` +
  "else (no engine data) engine running and not moving, an estimate that overstates idle for machines working standing still.";

/** "Idle", "Idle (estimated)" or "Idle (partly estimated)", depending on the sources behind the fleet figure. */
function idleLabel(t: Report["totals"]) {
  if (t.idleEstimatedHours <= 0) return "Idle";
  return t.idleMeasuredHours > 0 ? "Idle (partly estimated)" : "Idle (estimated)";
}

function Tile({ label, value, sub, help }: { label: string; value: string; sub?: React.ReactNode; help?: string }) {
  return (
    <div className={`${card} p-4`} title={help}>
      <div className="text-sm text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

/** Compliance with a status cue that isn't colour alone (icon + word). */
function ComplianceStatus({ rate, wordOnly = false }: { rate: number | null; wordOnly?: boolean }) {
  if (rate === null) return <span className="text-slate-400">—</span>;
  const [icon, word, cls] = rate >= 0.9 ? ["✓", "Good", "text-[#006300] dark:text-[#0ca30c]"] : rate >= 0.5 ? ["!", "Needs attention", "text-amber-700 dark:text-[#fab219]"] : ["✕", "Poor", "text-[#d03b3b]"];
  return (
    <span className={`inline-flex items-center gap-1 font-medium ${cls}`}>
      <span aria-hidden>{icon}</span>
      {wordOnly ? (
        word
      ) : (
        <>
          {Math.round(rate * 100)}% <span className="sr-only">{word}</span>
        </>
      )}
    </span>
  );
}

function Overview({ report }: { report: Report }) {
  const t = report.totals;
  const days = report.range.days.map((date) => {
    const total = report.machines.reduce((s, m) => s + (m.hoursByDay[date] ?? 0), 0);
    const idle = report.machines.reduce((s, m) => s + (m.idleByDay[date] ?? 0), 0);
    return { date, working: Math.max(0, total - idle), idle };
  });
  const byHours = [...report.machines].sort((a, b) => b.hours - a.hours);
  const unused = report.machines.filter((m) => m.daysUsed === 0);
  const compliance = t.daysOperated ? t.daysWithCheckin / t.daysOperated : null;
  return (
    <div className="space-y-5">
      <div className={`grid grid-cols-2 gap-3 md:grid-cols-3 ${t.fuelMachines ? "xl:grid-cols-7" : "xl:grid-cols-6"}`}>
        <Tile label="Engine hours" value={formatHours(t.hours)} sub={t.activeMachines ? `${formatHours(t.hours / t.activeMachines)} per active machine` : undefined} />
        <Tile
          label="Utilization"
          value={pct(t.utilization)}
          sub={`of ${report.plannedHoursPerDay} h per working day`}
          help="Engine hours ÷ planned hours (hours per working day × working days × machines). Set the plan under Settings."
        />
        <Tile
          label={idleLabel(t)}
          value={t.hours ? pct(t.idleHours / t.hours) : "—"}
          sub={
            <>
              {formatHours(t.idleHours)}
              {t.idleFuelL > 0 && ` · ${Math.round(t.idleFuelL).toLocaleString("en-CA")} L fuel`}
              {t.idleMeasuredHours > 0 && t.idleEstimatedHours > 0 && (
                <div>{pct(t.idleMeasuredHours / (t.idleMeasuredHours + t.idleEstimatedHours))} of hours measured</div>
              )}
            </>
          }
          help={IDLE_HELP}
        />
        <Tile label="Active machines" value={`${t.activeMachines} / ${t.machines}`} sub={unused.length ? `${unused.length} not used` : "all used"} />
        <Tile label="Active operators" value={String(t.activeOperators)} sub={`${t.checkins} check-ins`} />
        <Tile
          label="Checklist compliance"
          value={compliance === null ? "—" : `${Math.round(compliance * 100)}%`}
          sub={<ComplianceStatus rate={compliance} wordOnly />}
          help="Days a machine ran that had a pre-start check-in ÷ days it ran."
        />
        {t.fuelMachines > 0 && (
          <Tile
            label="Fuel used"
            value={`${Math.round(t.fuelL).toLocaleString("en-CA")} L`}
            sub={`${t.fuelMachines} machine${t.fuelMachines === 1 ? "" : "s"} reporting`}
            help="From the engine computer's fuel meter (J1939), on machines whose device reads it."
          />
        )}
      </div>

      <section className={`${card} space-y-3 p-4`}>
        <h2 className="font-semibold">Engine hours per day</h2>
        <DailyHoursChart days={days} idleLabel={idleLabel(t)} />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className={`${card} space-y-3 p-4`}>
          <h2 className="font-semibold">Hours by machine</h2>
          <HoursBars rows={byHours.slice(0, 15).map((m) => ({ key: m.id, label: machineLabel(m), hours: m.hours }))} empty="No machines." />
          {byHours.length > 15 && <p className="text-xs text-slate-500">Top 15 of {byHours.length}: see the Machines tab for all.</p>}
        </section>
        <section className={`${card} space-y-3 p-4`}>
          <h2 className="font-semibold">Hours by operator</h2>
          <HoursBars
            rows={report.operators
              .filter((o) => o.hours > 0)
              .slice(0, 15)
              .map((o) => ({ key: o.id, label: o.name, hours: o.hours }))}
            empty="No operator hours: hours count when the operator checked in before the engine started."
          />
          {t.hours > t.coveredHours + 0.01 && (
            <p className="text-xs text-slate-500">{formatHours(t.hours - t.coveredHours)} of engine time had nobody checked in.</p>
          )}
        </section>
      </div>

      {report.range.days.length <= 31 && (
        <section className={`${card} space-y-3 p-4`}>
          <h2 className="font-semibold">Daily activity</h2>
          <ActivityHeatmap days={report.range.days} rows={byHours.slice(0, 15).map((m) => ({ id: m.id, label: machineLabel(m), byDay: m.hoursByDay }))} />
        </section>
      )}

      {unused.length > 0 && (
        <section className={`${card} space-y-2 p-4`}>
          <h2 className="font-semibold">Not used in this period ({unused.length})</h2>
          <p className="text-sm text-slate-500">Candidates to move to another job, rent out or sell.</p>
          <ul className="flex flex-wrap gap-2 text-sm">
            {unused.map((m) => (
              <li key={m.id}>
                <Link href={`/machines/${m.id}`} className="rounded border border-slate-200 px-2 py-0.5 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  {machineLabel(m)}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function TableCard({ title, csv, children, note }: { title: string; csv: string; children: React.ReactNode; note?: string }) {
  return (
    <section className={`${card} overflow-hidden`}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-slate-800">
        <div>
          <h2 className="font-semibold">{title}</h2>
          {note && <p className="text-xs text-slate-500">{note}</p>}
        </div>
        <a href={csv} className="rounded border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          Download CSV
        </a>
      </div>
      <div className="overflow-x-auto">{children}</div>
    </section>
  );
}

const thead = "border-b border-slate-200 text-left text-xs uppercase text-slate-500 dark:border-slate-800";
const row = "border-b border-slate-100 last:border-0 dark:border-slate-800";

function Machines({ report, csv, now }: { report: Report; csv: string; now: number }) {
  const rows = [...report.machines].sort((a, b) => b.hours - a.hours);
  return (
    <TableCard title="Machines" csv={csv} note={`Utilization is against ${report.plannedHoursPerDay} h per working day (${formatHours(report.plannedHoursPerMachine)} in this period).`}>
      <table className="w-full text-sm">
        <thead className={thead}>
          <tr>
            <th className={th}>Machine</th>
            <th className={th}>Engine hours</th>
            <th className={th}>Idle</th>
            <th className={th}>Days used</th>
            <th className={th}>Utilization</th>
            <th className={th}>Last used</th>
            <th className={th}>Most time at</th>
            {report.totals.fuelMachines > 0 && <th className={th}>Fuel used</th>}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id} className={row}>
              <td className="px-3 py-2">
                <Link href={`/machines/${m.id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                  {machineLabel(m)}
                </Link>
                {(m.machineType || m.divisionName) && <div className="text-xs text-slate-500">{[m.machineType, m.divisionName].filter(Boolean).join(" · ")}</div>}
              </td>
              <td className={td}>{formatHours(m.hours)}</td>
              <td className={td}>
                {m.hours ? (
                  <>
                    {formatHours(m.idleHours)} ({pct(m.idleHours / m.hours)})
                    <div className={`text-xs ${isMeasuredIdle(m.idleSource) ? "text-slate-500" : "text-amber-700 dark:text-amber-400"}`}>
                      {m.idleSource ? IDLE_SOURCE_LABELS[m.idleSource] : ""}
                      {m.idleFuelL !== null && m.idleFuelL > 0 && ` · ${Math.round(m.idleFuelL)} L fuel`}
                    </div>
                  </>
                ) : (
                  "—"
                )}
              </td>
              <td className={td}>
                {m.daysUsed} / {report.range.days.length}
              </td>
              <td className={td}>
                <Meter value={m.utilization} />
              </td>
              <td className={td}>{m.lastUsed ? timeAgo(m.lastUsed, now) : "not in this period"}</td>
              <td className="px-3 py-2">{m.topWorksite ?? "—"}</td>
              {report.totals.fuelMachines > 0 && (
                <td className={td}>
                  {m.fuelL === null ? (
                    "—"
                  ) : (
                    <>
                      {Math.round(m.fuelL)} L
                      {m.hours > 0 && <div className="text-xs text-slate-500">{(m.fuelL / m.hours).toFixed(1)} L/h</div>}
                    </>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </TableCard>
  );
}

function Operators({ report, csv }: { report: Report; csv: string }) {
  return (
    <TableCard title="Operators" csv={csv} note="Engine hours count for the operator checked in when the engine ran.">
      {report.operators.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No check-ins in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Operator</th>
              <th className={th}>Engine hours</th>
              <th className={th}>Check-ins</th>
              <th className={th}>Machines</th>
              <th className={th}>Days</th>
              <th className={th}>Check-ins with defects</th>
            </tr>
          </thead>
          <tbody>
            {report.operators.map((o) => (
              <tr key={o.id} className={row}>
                <td className="px-3 py-2 font-medium">{o.name}</td>
                <td className={td}>{formatHours(o.hours)}</td>
                <td className={td}>{o.checkins}</td>
                <td className={td}>{o.machines}</td>
                <td className={td}>{o.days}</td>
                <td className={td}>{o.defects || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

function Compliance({ report, csv }: { report: Report; csv: string }) {
  const rows = [...report.machines]
    .filter((m) => m.daysUsed > 0 || m.checkins > 0)
    .sort((a, b) => (a.daysUsed ? a.daysWithCheckin / a.daysUsed : 1) - (b.daysUsed ? b.daysWithCheckin / b.daysUsed : 1));
  return (
    <TableCard
      title="Pre-start checklist compliance"
      csv={csv}
      note="Compliance = days the machine ran with a check-in ÷ days it ran. Starts without check-in = unauthorized-use alerts (armed Safety & Access Monitoring machines)."
    >
      {rows.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">No machine ran in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Machine</th>
              <th className={th}>Compliance</th>
              <th className={th}>Days with check-in</th>
              <th className={th}>Hours with operator</th>
              <th className={th}>Starts without check-in</th>
              <th className={th}>Check-ins (with defects)</th>
              <th className={th}>Days without a check-in</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id} className={row}>
                <td className="px-3 py-2">
                  <Link href={`/machines/${m.id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                    {machineLabel(m)}
                  </Link>
                </td>
                <td className={td}>
                  <ComplianceStatus rate={m.daysUsed ? m.daysWithCheckin / m.daysUsed : null} />
                </td>
                <td className={td}>
                  {m.daysWithCheckin} / {m.daysUsed}
                </td>
                <td className={td}>{m.hours ? `${formatHours(m.coveredHours)} (${pct(m.coveredHours / m.hours)})` : "—"}</td>
                <td className={td}>{m.startsWithoutCheckin || "—"}</td>
                <td className={td}>
                  {m.checkins}
                  {m.checkinsWithDefects > 0 && <span className="text-slate-500"> ({m.checkinsWithDefects})</span>}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500">{m.missedDays.map((d) => dayLabel(d, true)).join(", ") || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}

function Fuel({ report, csv, logCsv, timeZone, now }: { report: Report; csv: string; logCsv: string; timeZone: string; now: number }) {
  const rows = report.machines.filter((m) => m.fuelL !== null || m.refuels > 0 || m.thefts > 0);
  const litres = (v: number | null) => (v === null ? "" : ` · about ${Math.round(v).toLocaleString("en-CA")} L`);
  return (
    <div className="space-y-5">
      <TableCard
        title="Fuel by machine"
        csv={csv}
        note="Fuel used comes from the engine's fuel meter (J1939). Refuels and suspected thefts come from the tank level (J1939 or OBD-II)."
      >
        {rows.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">No machine reported fuel data in this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>Machine</th>
                <th className={th}>Fuel used</th>
                <th className={th}>Idle fuel</th>
                <th className={th}>Refuels</th>
                <th className={th}>Suspected thefts</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.id} className={row}>
                  <td className="px-3 py-2">
                    <Link href={`/machines/${m.id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                      {machineLabel(m)}
                    </Link>
                  </td>
                  <td className={td}>
                    {m.fuelL === null ? "—" : `${Math.round(m.fuelL).toLocaleString("en-CA")} L`}
                    {m.fuelL !== null && m.hours > 0 && <div className="text-xs text-slate-500">{(m.fuelL / m.hours).toFixed(1)} L/h</div>}
                  </td>
                  <td className={td}>{m.idleFuelL === null ? "—" : `${Math.round(m.idleFuelL)} L`}</td>
                  <td className={td}>
                    {m.refuels || "—"}
                    {m.refuels > 0 && <span className="text-slate-500">{litres(m.refuelL)}</span>}
                  </td>
                  <td className={td}>
                    {m.thefts ? (
                      <span className="font-medium text-red-700 dark:text-red-400">
                        ⚠ {m.thefts}
                        <span className="font-normal">{litres(m.theftL)}</span>
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
      <TableCard title="Fuel log" csv={logCsv} note="Every refuel and suspected theft in the period.">
        {report.fuelLog.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Nothing in this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>When</th>
                <th className={th}>Machine</th>
                <th className={th}>What</th>
                <th className={th}>Level</th>
                <th className={th}>Litres</th>
              </tr>
            </thead>
            <tbody>
              {[...report.fuelLog].reverse().map((e) => (
                <tr key={e.id} className={row}>
                  <td className={td}>{clockTime(e.at, timeZone, now)}</td>
                  <td className="px-3 py-2">{e.machine}</td>
                  <td className="px-3 py-2">
                    {e.kind === "refuel" ? (
                      <>⛽ Refuel{e.when === "running" && <span className="text-slate-500"> (engine running)</span>}</>
                    ) : (
                      <span className="font-medium text-red-700 dark:text-red-400">⚠ {e.kind === "theft" ? "Dropped while parked" : "Lost while running"}</span>
                    )}
                  </td>
                  <td className={td}>
                    {Math.round(e.fromPct)}% → {Math.round(e.toPct)}%
                  </td>
                  <td className={td}>{e.litres === null ? "—" : Math.round(e.litres)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
    </div>
  );
}

function Safety({ report, csv, timeZone, now }: { report: Report; csv: string; timeZone: string; now: number }) {
  const counts = (Object.keys(SAFETY_KINDS) as SafetyKind[]).map((k) => ({ kind: k, n: report.safetyLog.filter((e) => e.kind === k).length }));
  const value = (e: Report["safetyLog"][number]) => {
    if (e.peak === null) return "—";
    if (e.kind === "speeding") return `${Math.round(e.peak)} km/h (limit ${Math.round(e.limitValue ?? 0)})`;
    if (e.kind === "excessive_idle") return `${formatHours(e.peak / 60)}${e.endedAt ? "" : " so far"}`;
    return `${formatHours(e.peak)} (limit ${formatHours(e.limitValue ?? 0)})`;
  };
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        {counts.map((c) => (
          <div key={c.kind} className={`${card} p-3`}>
            <div className="text-xs text-slate-500">{SAFETY_KINDS[c.kind]}</div>
            <div className="text-2xl font-semibold tabular-nums">{c.n}</div>
          </div>
        ))}
      </div>
      <TableCard
        title="Safety log"
        csv={csv}
        note="Speeding over 10 seconds (fleet or worksite limit), restricted-area entries, idling over the limit (machines that report RPM) and operator fatigue. Limits are on the Settings page."
      >
        {report.safetyLog.length === 0 ? (
          <p className="p-4 text-sm text-slate-500">Nothing in this period.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className={thead}>
              <tr>
                <th className={th}>When</th>
                <th className={th}>What</th>
                <th className={th}>Machine</th>
                <th className={th}>Operator</th>
                <th className={th}>How much</th>
                <th className={th}>Where</th>
              </tr>
            </thead>
            <tbody>
              {report.safetyLog.map((e) => (
                <tr key={e.id} className={row}>
                  <td className={td}>{clockTime(e.startedAt, timeZone, now)}</td>
                  <td className="px-3 py-2 font-medium">{SAFETY_KINDS[e.kind as SafetyKind] ?? e.kind}</td>
                  <td className="px-3 py-2">
                    <Link href={`/machines/${e.machineId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                      {e.machine}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{e.operator ?? "—"}</td>
                  <td className={td}>{value(e)}</td>
                  <td className="px-3 py-2">{e.worksite ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </TableCard>
    </div>
  );
}

function Worksites({ report, csv }: { report: Report; csv: string }) {
  return (
    <TableCard title="Worksites" csv={csv} note="Time on site counts each machine's visit; engine hours on site is the part of that time its engine was running.">
      {report.worksites.length === 0 ? (
        <p className="p-4 text-sm text-slate-500">
          No machine was at a worksite in this period.{" "}
          <Link href="/worksites" className="text-sky-700 hover:underline dark:text-sky-400">
            Draw worksites
          </Link>
          .
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className={thead}>
            <tr>
              <th className={th}>Worksite</th>
              <th className={th}>Engine hours on site</th>
              <th className={th}>Time on site</th>
              <th className={th}>Visits</th>
              <th className={th}>Machines</th>
              <th className={th}>Average visit</th>
            </tr>
          </thead>
          <tbody>
            {report.worksites.map((w) => (
              <tr key={w.id} className={row}>
                <td className="px-3 py-2">
                  <span className="mr-2 inline-block h-2.5 w-2.5 rounded-full" style={{ background: worksiteColor(w.type) }} />
                  <span className="font-medium">{w.name}</span>
                  <div className="text-xs text-slate-500">{WORKSITE_TYPES[w.type as WorksiteType]?.label ?? w.type}</div>
                </td>
                <td className={td}>{formatHours(w.engineHours)}</td>
                <td className={td}>{formatHours(w.timeOnSiteHours)}</td>
                <td className={td}>{w.visits}</td>
                <td className={td}>{w.machines}</td>
                <td className={td}>{w.avgVisitHours === null ? "—" : formatHours(w.avgVisitHours)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </TableCard>
  );
}
