import { machineLocationHistory } from "@/lib/data";
import { toCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/** A machine's positions for the chosen period as CSV (the same positions the map shows). */
export async function GET(request: Request, { params }: RouteContext<"/machines/[id]/history/export">) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams;
  const data = await machineLocationHistory(id, { range: q.get("range") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined }).catch(() => null);
  if (!data) return new Response("Not found", { status: 404 });
  const { history, timeZone, range } = data;
  const time = (ms: number) => new Date(ms).toLocaleString("sv-SE", { timeZone });
  const operatorAt = (t: number) => history.operators.find((o) => o.from <= t && t <= o.to)?.name ?? "";
  const body = toCsv([
    [`Time (${timeZone})`, "Latitude", "Longitude", "Speed (km/h)", "Heading", "Engine", "Operator"],
    ...history.points.map((p) => [
      time(p.t),
      Number(p.lat.toFixed(6)),
      Number(p.lng.toFixed(6)),
      p.kph === null ? "" : Number(p.kph.toFixed(1)),
      p.heading ?? "",
      p.engineOn === null ? "" : p.engineOn ? "On" : "Off",
      operatorAt(p.t),
    ]),
  ]);
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="positions-machine-${id}-${range.fromInput.slice(0, 10)}-to-${range.toInput.slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
