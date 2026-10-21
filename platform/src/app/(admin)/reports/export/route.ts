import { reportData } from "@/lib/data";
import { REPORT_CSV, toCsv, type ReportCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/** A report as a CSV file (opens in Excel), with the same filters as the Reports page. */
export async function GET(request: Request) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const url = new URL(request.url);
  const kind = url.searchParams.get("report") ?? "";
  if (!(kind in REPORT_CSV)) return new Response("Unknown report", { status: 404 });
  const get = (k: string) => url.searchParams.get(k) ?? undefined;
  const { report } = await reportData({ range: get("range"), from: get("from"), to: get("to"), division: get("division") });
  const body = toCsv(REPORT_CSV[kind as ReportCsv](report));
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vs-lab-${kind}-${report.range.fromDate}-to-${report.range.toDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
