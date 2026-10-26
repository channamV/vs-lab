import Link from "next/link";
import { Suspense } from "react";
import { checklistResults } from "@/lib/data";
import { filterQuery, RESULT_FILTERS, RESULT_RULES, resultMachine } from "@/lib/checklist-results";
import { RANGE_PRESETS } from "@/lib/reports";
import { ResultBadge } from "./ResultView";

/**
 * Pre-start checklist results (docs/checklist-results.md): every completed checklist, filtered by date, machine,
 * division, operator and result, with a CSV and a printable report of the same filter. Filters live in the URL.
 */

type Params = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
const card = "rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
const field = "rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700";
const button = "rounded-full border border-slate-300 px-3 py-1 text-sm text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";

export default function ChecklistResultsPage({ searchParams }: PageProps<"/checklists/results">) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Checklist results</h1>
        <p className="text-sm text-slate-500">Pre-start checklists operators completed at check-in: answers, defects, notes and photos.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Results searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Results({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const params = Object.fromEntries(["range", "from", "to", "machine", "operator", "division", "result", "covered", "page"].map((k) => [k, one(sp[k])]));
  const { rows, total, filters: f, choices, timeZone } = await checklistResults(params);
  const when = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" });
  const pages = Math.max(1, Math.ceil(total / RESULT_RULES.pageSize));
  const qs = filterQuery(f);
  return (
    <>
      <form action="/checklists/results" className={`${card} flex flex-wrap items-end gap-3 p-3 text-sm`}>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Dates</span>
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
            {choices.machines.map((m) => (
              <option key={m.id} value={m.id}>
                {resultMachine({ unitNumber: m.unitNumber, machineName: m.name })}
              </option>
            ))}
          </select>
        </label>
        {choices.divisions.length > 0 && (
          <label className="flex flex-col gap-1">
            <span className="text-slate-500">Division</span>
            <select name="division" defaultValue={f.divisionId ?? ""} className={field}>
              <option value="">All divisions</option>
              {choices.divisions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Operator</span>
          <select name="operator" defaultValue={f.operatorId ?? ""} className={field}>
            <option value="">All operators</option>
            {choices.operators.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-slate-500">Result</span>
          <select name="result" defaultValue={f.result} className={field}>
            {Object.entries(RESULT_FILTERS).map(([k, label]) => (
              <option key={k} value={k}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 py-1">
          <input type="checkbox" name="covered" value="1" defaultChecked={f.includeCovered} />
          <span>Include &ldquo;done earlier today&rdquo;</span>
        </label>
        <button className="rounded-full bg-sky-700 px-4 py-1.5 text-sm font-medium text-white hover:bg-sky-800">Apply</button>
      </form>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {total === 0 ? "No checklists" : `${total.toLocaleString("en-CA")} checklist${total === 1 ? "" : "s"}`} from {f.range.fromDate} to {f.range.toDate}
        </p>
        {total > 0 && (
          <div className="flex gap-2">
            <a href={`/checklists/results/export?${qs}`} className={button}>
              Download CSV
            </a>
            <Link href={`/checklists/results/print?${qs}`} className={button}>
              Print / PDF report
            </Link>
          </div>
        )}
      </div>
      {total > RESULT_RULES.maxPrint && (
        <p className="text-xs text-slate-500">
          The printable report holds the newest {RESULT_RULES.maxPrint}; the CSV holds up to {RESULT_RULES.maxExport.toLocaleString("en-CA")}. Narrow the filter for more.
        </p>
      )}

      {rows.length > 0 && (
        <div className={`${card} overflow-x-auto`}>
          <table className="w-full text-sm">
            <thead className="border-b border-slate-200 text-left text-slate-500 dark:border-slate-800">
              <tr>
                <th className="px-3 py-2 font-medium">When</th>
                <th className="px-3 py-2 font-medium">Machine</th>
                <th className="px-3 py-2 font-medium">Operator</th>
                <th className="px-3 py-2 font-medium">Checklist</th>
                <th className="px-3 py-2 font-medium">Result</th>
                <th className="px-3 py-2 font-medium">Photos</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50">
                  <td className="px-3 py-2 whitespace-nowrap">
                    <Link href={`/checklists/results/${r.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                      {when.format(r.startedAt)}
                    </Link>
                  </td>
                  <td className="px-3 py-2">{resultMachine(r)}</td>
                  <td className="px-3 py-2">{r.operatorName}</td>
                  <td className="px-3 py-2 text-slate-600 dark:text-slate-400">{r.templateName ?? "—"}</td>
                  <td className="px-3 py-2">
                    <ResultBadge kind={r.result} defects={r.answers.filter((a) => !a.ok).length} />
                  </td>
                  <td className="px-3 py-2 tabular-nums">{r.photos.length || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {pages > 1 && (
        <nav className="flex items-center gap-3 text-sm" aria-label="Pages">
          {f.page > 1 && (
            <Link href={`/checklists/results?${filterQuery(f, { page: f.page - 1 })}`} className={button}>
              ← Newer
            </Link>
          )}
          <span className="text-slate-500">
            Page {f.page} of {pages}
          </span>
          {f.page < pages && (
            <Link href={`/checklists/results?${filterQuery(f, { page: f.page + 1 })}`} className={button}>
              Older →
            </Link>
          )}
        </nav>
      )}
    </>
  );
}
