import { checklistResultsForExport } from "@/lib/data";
import { RESULT_RULES, resultsCsvRows } from "@/lib/checklist-results";
import { toCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/** Checklist results as a CSV file (one row per answer), with the same filters as the Checklist results page. */
export async function GET(request: Request) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const url = new URL(request.url);
  const params = Object.fromEntries(["range", "from", "to", "machine", "operator", "division", "result", "covered"].map((k) => [k, url.searchParams.get(k) ?? undefined]));
  const { rows, filters, timeZone, coveringTimes } = await checklistResultsForExport(params, RESULT_RULES.maxExport);
  const body = toCsv(resultsCsvRows(rows, timeZone, coveringTimes));
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vs-lab-checklists-${filters.range.fromDate}-to-${filters.range.toDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
