import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { companyTimeZone, getDeviceForStaff, requestTime } from "@/lib/data";
import { clockTime, fmt, machineLabel, timeAgo } from "@/lib/format";
import { restartLabel } from "@/lib/restart-reasons";
import { Commands } from "./Commands";

/** Veristart staff only: one tracking device's health and the machines it has been on. */
export default function DevicePage({ params }: PageProps<"/platform/devices/[id]">) {
  return (
    <div className="space-y-6">
      <Link href="/platform" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Platform
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading device…</p>}>
        <DeviceDetail params={params} />
      </Suspense>
    </div>
  );
}

async function DeviceDetail({ params }: Pick<PageProps<"/platform/devices/[id]">, "params">) {
  const device = await getDeviceForStaff(decodeURIComponent((await params).id));
  if (!device) notFound();
  const now = await requestTime();
  const tz = await companyTimeZone();
  const current = device.pairings.find((p) => !p.endedAt);

  return (
    <>
      <div>
        <h1 className="font-mono text-2xl font-semibold">{device.id}</h1>
        <p className="text-sm text-slate-500">
          {current
            ? `On ${machineLabel({ name: current.machineName, unitNumber: current.unitNumber })} · ${current.organizationName}`
            : device.stockOrganization
              ? `Spare in ${device.stockOrganization}'s stock`
              : "Veristart stock"}
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border border-slate-200 bg-white p-4 text-sm sm:grid-cols-4 dark:border-slate-800 dark:bg-slate-900">
        <dt className="text-slate-500">First report</dt>
        <dd>{clockTime(device.firstSeenAt, tz, now)}</dd>
        <dt className="text-slate-500">Last report</dt>
        <dd>{timeAgo(device.lastSeenAt, now)}</dd>
        <dt className="text-slate-500">Battery</dt>
        <dd>{fmt(device.lastBatteryV, 1, " V")}</dd>
        <dt className="text-slate-500">Signal</dt>
        <dd>{device.lastRssi === null ? "—" : `${device.lastRssi} dBm`}</dd>
        <dt className="text-slate-500">Last GPS fix</dt>
        <dd>{timeAgo(device.lastFixAt, now)}</dd>
        <dt className="text-slate-500">VIN (OBD)</dt>
        <dd className="font-mono">{device.vin ?? "—"}</dd>
        <dt className="text-slate-500">Firmware</dt>
        <dd>
          {device.firmwareVersion ? (
            <span className="font-mono">{device.firmwareVersion}</span>
          ) : (
            <span className="text-slate-500">Not reported (stock Telelogger)</span>
          )}{" "}
          <Link href="/platform/firmware" className="text-sky-700 hover:underline dark:text-sky-400">
            Updates
          </Link>
        </dd>
      </dl>

      <Suspense fallback={<p className="text-sm text-slate-500">Loading commands…</p>}>
        <Commands deviceId={device.id} />
      </Suspense>

      <section className="space-y-2">
        <h2 className="font-semibold">Machines it has been on</h2>
        {device.pairings.length === 0 ? (
          <p className="text-sm text-slate-500">Never paired.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {device.pairings.map((p) => (
              <li key={p.startedAt.toISOString()} className="flex flex-wrap gap-x-4 px-4 py-2">
                <span className="font-medium">{machineLabel({ name: p.machineName, unitNumber: p.unitNumber })}</span>
                <span className="text-slate-500">{p.organizationName}</span>
                <span className="text-slate-500">
                  {clockTime(p.startedAt, tz, now)} – {p.endedAt ? clockTime(p.endedAt, tz, now) : "now"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Latest data</h2>
        {device.latest ? (
          <pre className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4 text-xs dark:border-slate-800 dark:bg-slate-900">
            {JSON.stringify(device.latest.fields, null, 1)}
          </pre>
        ) : (
          <p className="text-sm text-slate-500">No data yet.</p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Restart reports</h2>
        <p className="text-sm text-slate-500">
          Sent by our firmware after a restart: why it restarted and its last log lines from the memory card (the latest 10).
        </p>
        {device.diagnostics.length === 0 ? (
          <p className="text-sm text-slate-500">None yet (needs our firmware with restart reports).</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {device.diagnostics.map((d) => (
              <li key={d.id} className="px-4 py-2">
                <details>
                  <summary className="cursor-pointer">
                    <span className="text-slate-500">{clockTime(d.receivedAt, tz, now)}</span> · {restartLabel(d.restartReason)}
                    {d.bootNumber !== null && <span className="text-slate-500"> · start-up #{d.bootNumber}</span>}
                    <span className="text-slate-500"> · {d.lines.length} log lines</span>
                  </summary>
                  <pre className="mt-2 max-h-96 overflow-auto rounded bg-slate-50 p-2 text-xs whitespace-pre-wrap dark:bg-slate-800">{d.lines.join("\n")}</pre>
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Connection events</h2>
        {device.events.length === 0 ? (
          <p className="text-sm text-slate-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {device.events.map((e) => (
              <li key={e.id} className="flex gap-4 px-4 py-2">
                <span className="w-28 text-slate-500">{timeAgo(e.at, now)}</span>
                <span className="font-medium">{e.type}</span>
                {e.rssi !== null && <span className="text-slate-500">{e.rssi} dBm</span>}
                {e.detail && <span className="text-slate-500">{e.detail}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
