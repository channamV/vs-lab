import { machineEngineReadings } from "@/lib/data";
import { HISTORY_RULES } from "@/lib/history";
import { toCsv } from "@/lib/reports";
import { getAuth } from "@/lib/session";

/**
 * Every reading for the chosen period as CSV, with or without a position: engine state, speed, RPM, fuel level,
 * odometer, battery. For checking what a fuel log entry or an engine period was based on (docs/location-history.md).
 */
export async function GET(request: Request, { params }: RouteContext<"/machines/[id]/history/readings">) {
  if (!(await getAuth())) return new Response("Sign in first.", { status: 401 });
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return new Response("Not found", { status: 404 });
  const q = new URL(request.url).searchParams;
  const data = await machineEngineReadings(id, { range: q.get("range") ?? undefined, from: q.get("from") ?? undefined, to: q.get("to") ?? undefined }).catch(() => null);
  if (!data) return new Response("Not found", { status: 404 });
  const { readings, timeZone, range } = data;
  const time = (d: Date) => d.toLocaleString("sv-SE", { timeZone });
  const n = (v: number | null, digits = 1) => (v === null ? "" : Number(Number(v).toFixed(digits)));
  const body = toCsv([
    [`Time (${timeZone})`, "Received", "Engine", "Speed (km/h)", "RPM", "Fuel level (%)", "Odometer (km)", "Battery (V)", "Coolant (°C)", "Latitude", "Longitude"],
    ...readings.map((r) => [
      time(r.at),
      time(r.receivedAt),
      r.engineOn === null ? "" : r.engineOn ? "On" : "Off",
      n(r.speedKph),
      n(r.rpm, 0),
      n(r.fuelPct),
      n(r.odometerKm),
      n(r.batteryV, 2),
      n(r.coolantC, 0),
      n(r.lat, 6),
      n(r.lng, 6),
    ]),
    ...(readings.length >= HISTORY_RULES.maxReadings ? [[`Only the first ${HISTORY_RULES.maxReadings.toLocaleString("en-CA")} readings: choose a shorter period for the rest.`]] : []),
  ]);
  return new Response(`﻿${body}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="readings-machine-${id}-${range.fromInput.slice(0, 10)}-to-${range.toInput.slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
