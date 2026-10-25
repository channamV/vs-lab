import { machineVoltage } from "@/lib/data";
import { toCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/** A machine's battery voltage history as CSV (one row per time slice, as on the chart). */
export async function GET(request: Request, { params }: RouteContext<"/machines/[id]/battery/export">) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const { range, timeZone, history } = await machineVoltage(id, new URL(request.url).searchParams.get("battery") ?? undefined).catch(() => ({ range: null, timeZone: "", history: null }));
  if (!range || !history) return new Response("Not found", { status: 404 });
  const time = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone }).slice(0, 16);
  const body = toCsv([
    [`From (${timeZone})`, "Average V", "Lowest V", "Highest V", "Readings", "Engine running"],
    ...history.points.map((p) => [time(p.t), p.avg.toFixed(2), p.min.toFixed(2), p.max.toFixed(2), p.n, p.engineOn ? "Yes" : "No"]),
  ]);
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="battery-machine-${id}-${range.preset}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
