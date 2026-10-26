import { maintenanceHistory } from "@/lib/data";
import { HISTORY_RULES, historyCsvRows } from "@/lib/maintenance-queries";
import { toCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/** Maintenance history as a CSV (one row per item), with the same filters as the History page. */
export async function GET(request: Request) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const url = new URL(request.url);
  const params = Object.fromEntries(["range", "from", "to", "machine", "status", "source"].map((k) => [k, url.searchParams.get(k) ?? undefined]));
  const { rows, filters, timeZone } = await maintenanceHistory(params, HISTORY_RULES.maxExport);
  return new Response(`﻿${toCsv(historyCsvRows(rows, timeZone))}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="vs-lab-maintenance-${filters.range.fromDate}-to-${filters.range.toDate}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
