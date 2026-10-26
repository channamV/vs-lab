import Link from "next/link";
import { Suspense } from "react";
import { checklistResultsForExport } from "@/lib/data";
import { filterQuery, RESULT_RULES, type ResultKind } from "@/lib/checklist-results";
import { PrintButton } from "../PrintButton";
import { ResultView } from "../ResultView";

/** Every checklist matching the filter in one printable document (print, or "Save as PDF"), one per page. */

type Params = { [key: string]: string | string[] | undefined };
const SUMMARY: Record<ResultKind, string> = { ok: "all OK", defects: "with defects", locked_out: "locked out", covered: "done earlier today" };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default function PrintResultsPage({ searchParams }: PageProps<"/checklists/results/print">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Preparing the report…</p>}>
      <PrintResults searchParams={searchParams} />
    </Suspense>
  );
}

async function PrintResults({ searchParams }: { searchParams: Promise<Params> }) {
  const sp = await searchParams;
  const params = Object.fromEntries(["range", "from", "to", "machine", "operator", "division", "result", "covered"].map((k) => [k, one(sp[k])]));
  const { rows, total, filters, timeZone } = await checklistResultsForExport(params, RESULT_RULES.maxPrint);
  const counts = new Map<ResultKind, number>();
  for (const r of rows) counts.set(r.result, (counts.get(r.result) ?? 0) + 1);
  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href={`/checklists/results?${filterQuery(filters)}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← Checklist results
        </Link>
        <PrintButton />
      </div>
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold">Pre-start checklist report</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          {filters.range.fromDate} to {filters.range.toDate} · {rows.length} checklist{rows.length === 1 ? "" : "s"}
          {total > rows.length && ` (newest ${rows.length} of ${total}; narrow the filter for the rest)`}
          {rows.length > 0 && ` · ${[...counts].map(([k, n]) => `${n} ${SUMMARY[k]}`).join(", ")}`}
        </p>
      </header>
      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No checklists match this filter.</p>
      ) : (
        rows.map((r, i) => (
          <div key={r.id} className={i > 0 ? "border-t border-slate-200 pt-6 print:break-before-page print:border-0 print:pt-0 dark:border-slate-800" : ""}>
            <ResultView r={r} timeZone={timeZone} linkMachine={false} />
          </div>
        ))
      )}
    </div>
  );
}
