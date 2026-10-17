import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FleetMap, type MapMarker } from "@/components/FleetMap";
import { StatusBadge } from "@/components/StatusBadge";
import { EngineBadge } from "@/components/EngineBadge";
import { connectionStatus, currentCheckins, engineHoursToday, engineStatus, listDevices, openAlerts, requestTime } from "@/lib/data";
import { isArmed, isMonitored } from "@/lib/alerts";
import { appTimeZone } from "@/lib/telemetry/engine";
import { clockTime, fmt, formatHours, TIER_LABELS, timeAgo } from "@/lib/format";
import { checkinFlags } from "@/lib/checkin-flags";

export default function FleetPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Fleet</h1>
        <p className="text-sm text-slate-500">Where your equipment is and when it last reported.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading fleet…</p>}>
        <FleetOverview />
      </Suspense>
    </div>
  );
}

async function FleetOverview() {
  const [devices, now, hoursToday, checkedIn, alerts] = await Promise.all([
    listDevices(),
    requestTime(),
    engineHoursToday(),
    currentCheckins(),
    openAlerts(),
  ]);
  const tz = appTimeZone();

  if (devices.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-slate-300 p-8 text-center dark:border-slate-700">
        <AutoRefresh />
        <p className="font-medium">No devices have reported yet.</p>
        <p className="mt-1 text-sm text-slate-500">
          Run <code className="rounded bg-slate-100 px-1 dark:bg-slate-800">npm run simulate</code> to send test data,
          or point a Freematics device at this server. New devices appear here automatically.
        </p>
      </div>
    );
  }

  const markers: MapMarker[] = devices
    .filter((d) => d.lastLat !== null && d.lastLng !== null)
    .map((d) => ({
      id: d.id,
      label: d.name ?? d.id,
      lat: d.lastLat!,
      lng: d.lastLng!,
      status: connectionStatus(d, now),
    }));

  const unauthorized = alerts.filter((a) => a.type === "unauthorized-use").length;
  return (
    <>
      <AutoRefresh />
      {alerts.length > 0 && (
        <Link
          href="/alerts"
          className={`block rounded-lg border px-4 py-3 text-sm font-medium ${
            unauthorized
              ? "border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300"
              : "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200"
          }`}
        >
          ⚠ {alerts.length} open alert{alerts.length === 1 ? "" : "s"}
          {unauthorized > 0 && ` (${unauthorized} unauthorized use)`}. View alerts →
        </Link>
      )}
      <FleetMap markers={markers} />
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
            <tr>
              <th className="px-4 py-2">Machine</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2">Engine</th>
              <th className="px-4 py-2 text-right">Hours today</th>
              <th className="px-4 py-2">Operator</th>
              <th className="px-4 py-2">Level</th>
              <th className="px-4 py-2">Last report</th>
              <th className="px-4 py-2 text-right">Speed</th>
              <th className="px-4 py-2 text-right">Battery</th>
              <th className="px-4 py-2 text-right">Signal</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="px-4 py-2">
                  <Link href={`/devices/${encodeURIComponent(d.id)}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                    {d.name ?? "Unnamed machine"}
                  </Link>
                  <div className="font-mono text-xs text-slate-500">{d.id}</div>
                </td>
                <td className="px-4 py-2">
                  <StatusBadge status={connectionStatus(d, now)} />
                </td>
                <td className="px-4 py-2">
                  <EngineBadge status={engineStatus(d, now)} />
                  {d.engineChangedAt && engineStatus(d, now) !== "unknown" && (
                    <div className="mt-0.5 text-xs text-slate-500">since {clockTime(d.engineChangedAt, tz, now)}</div>
                  )}
                </td>
                <td className="px-4 py-2 text-right">{hoursToday.has(d.id) ? formatHours(hoursToday.get(d.id)!) : "—"}</td>
                <td className="px-4 py-2">
                  <OperatorCell checkin={checkedIn.get(d.id)} timeZone={tz} now={now} />
                </td>
                <td className="px-4 py-2">
                  {TIER_LABELS[d.tier]}
                  {isMonitored(d) && !isArmed(d, now) && <div className="text-xs text-slate-500">Disarmed</div>}
                </td>
                <td className="px-4 py-2">{timeAgo(d.lastSeenAt, now)}</td>
                <td className="px-4 py-2 text-right">{fmt(d.lastSpeedKph, 0, " km/h")}</td>
                <td className="px-4 py-2 text-right">{fmt(d.lastBatteryV, 1, " V")}</td>
                <td className="px-4 py-2 text-right">{d.lastRssi === null ? "—" : `${d.lastRssi} dBm`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function OperatorCell({
  checkin,
  timeZone,
  now,
}: {
  checkin?: Parameters<typeof checkinFlags>[0] & { operatorName: string; engineOffSince: Date | null };
  timeZone: string;
  now: number;
}) {
  if (!checkin) return <span className="text-slate-500">—</span>;
  const flags = checkinFlags(checkin);
  return (
    <>
      {checkin.operatorName}
      {checkin.engineOffSince && (
        <div className="text-xs text-slate-500">on a break, engine off since {clockTime(checkin.engineOffSince, timeZone, now)}</div>
      )}
      {flags.length > 0 && <div className="text-xs text-amber-700 dark:text-amber-400">{flags.join(", ")}</div>}
    </>
  );
}
