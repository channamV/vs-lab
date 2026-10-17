import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { FleetMap } from "@/components/FleetMap";
import { StatusBadge } from "@/components/StatusBadge";
import { EngineBadge } from "@/components/EngineBadge";
import { EngineHoursChart } from "@/components/EngineHoursChart";
import {
  allowedOperatorIds,
  connectionStatus,
  currentCheckins,
  engineHoursByDay,
  engineStatus,
  getDevice,
  getRecentEvents,
  getRecentTelemetry,
  getTrack,
  listOperators,
  openAlerts,
  recentCheckins,
  recentEngineSessions,
  requestTime,
} from "@/lib/data";
import { appTimeZone, effectiveEnd } from "@/lib/telemetry/engine";
import { tierEnum } from "@/lib/db/schema";
import { PID_NAMES } from "@/lib/freematics/protocol";
import { clockTime, fmt, formatHours, TIER_LABELS, timeAgo } from "@/lib/format";
import { checkinFlags, engineLabel, locationLabel } from "@/lib/checkin-flags";
import { endCheckinAction, setAllowedOperators, setArming, updateDevice } from "./actions";
import { AlertList } from "../../alerts/AlertList";
import { ALERT_RULES, isArmed, isMonitored } from "@/lib/alerts";

export default function DevicePage({ params }: PageProps<"/devices/[id]">) {
  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Fleet
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading machine…</p>}>
        <DeviceDetail params={params} />
      </Suspense>
    </div>
  );
}

async function DeviceDetail({ params }: { params: PageProps<"/devices/[id]">["params"] }) {
  const id = decodeURIComponent((await params).id);
  const device = await getDevice(id);
  if (!device) notFound();

  const [track, [latest], events, now, hours, sessions, current, history, operators, allowed, alerts] = await Promise.all([
    getTrack(id),
    getRecentTelemetry(id, 1),
    getRecentEvents(id),
    requestTime(),
    engineHoursByDay(id, 7),
    recentEngineSessions(id, 8),
    currentCheckins().then((m) => m.get(id) ?? null),
    recentCheckins(id, 10),
    listOperators(),
    allowedOperatorIds(id),
    openAlerts(id),
  ]);
  const tz = appTimeZone();
  const engine = engineStatus(device, now);
  const status = connectionStatus(device, now);

  return (
    <>
      <AutoRefresh />
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{device.name ?? "Unnamed machine"}</h1>
        <StatusBadge status={status} />
        <span className="font-mono text-sm text-slate-500">{device.id}</span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-7">
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs uppercase text-slate-500">Engine</div>
          <div className="mt-1.5">
            <EngineBadge status={engine} />
          </div>
          {device.engineChangedAt && engine !== "unknown" && (
            <div className="mt-1 text-xs text-slate-500">since {clockTime(device.engineChangedAt, tz, now)}</div>
          )}
        </div>
        <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
          <div className="text-xs uppercase text-slate-500">Operator</div>
          <div className="mt-1 font-semibold">{current ? current.operatorName : <span className="text-slate-500">None</span>}</div>
          {current && <div className="text-xs text-slate-500">since {clockTime(current.startedAt, tz, now)}</div>}
        </div>
        <Stat label="Hours today" value={formatHours(hours.at(-1)?.hours ?? 0)} />
        <Stat label="Last report" value={timeAgo(device.lastSeenAt, now)} />
        <Stat label="Last GPS fix" value={timeAgo(device.lastFixAt, now)} />
        <Stat label="Battery" value={fmt(device.lastBatteryV, 1, " V")} />
        <Stat label="Signal" value={device.lastRssi === null ? "—" : `${device.lastRssi} dBm`} />
      </div>

      {device.lastLat !== null && device.lastLng !== null ? (
        <section className="space-y-2">
          <h2 className="font-semibold">Last 24 hours</h2>
          <FleetMap
            markers={[{ id: device.id, label: device.name ?? device.id, lat: device.lastLat, lng: device.lastLng, status }]}
            track={track}
          />
        </section>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-300 p-6 text-sm text-slate-500 dark:border-slate-700">
          No GPS position yet. A new device can take a few minutes to get its first fix — it needs a clear view of the sky.
        </p>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Engine hours</h2>
          <EngineHoursChart days={hours} timeZone={tz} />
        </section>
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Recent engine sessions</h2>
          {sessions.length === 0 ? (
            <p className="text-sm text-slate-500">No engine activity recorded yet.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1">Started</th>
                  <th className="py-1">Ended</th>
                  <th className="py-1 text-right">Duration</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {sessions.map((s) => {
                  const end = effectiveEnd(s, now);
                  const ongoing = !s.endedAt && end === now;
                  return (
                    <tr key={s.id}>
                      <td className="py-1.5">{clockTime(s.startedAt, tz, now)}</td>
                      <td className="py-1.5">
                        {ongoing ? (
                          <span className="text-emerald-700 dark:text-emerald-400">Running</span>
                        ) : (
                          <>
                            {clockTime(new Date(end), tz, now)}
                            {!s.endedAt && <span className="text-slate-500"> (last report)</span>}
                          </>
                        )}
                      </td>
                      <td className="py-1.5 text-right">{formatHours((end - s.startedAt.getTime()) / 3_600_000)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {sessions.length > 0 && (
          <p className="text-xs text-slate-500">
            Detected from {sessions[0].source === "rpm" ? "engine RPM" : sessions[0].source === "vibration" ? "vibration" : "alternator voltage"}.
          </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-2 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Open alerts</h2>
          {alerts.length === 0 ? (
            <p className="text-sm text-slate-500">None.</p>
          ) : (
            <AlertList alerts={alerts} timeZone={tz} now={now} showMachine={false} />
          )}
        </section>
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Monitoring</h2>
          {isMonitored(device) ? (
            <>
              {isArmed(device, now) ? (
                <p className="text-sm">
                  <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
                    Armed
                  </span>{" "}
                  Alerts if the engine runs {ALERT_RULES.unauthorizedGraceMinutes} min with nobody checked in.
                </p>
              ) : (
                <p className="text-sm">
                  <span className="rounded-full bg-slate-200 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-300">
                    Disarmed
                  </span>{" "}
                  {device.disarmedUntil ? `until ${clockTime(device.disarmedUntil, tz, now)}` : "until re-armed"}. No unauthorized-use
                  alerts.
                </p>
              )}
              <form action={setArming} className="flex flex-wrap gap-2">
                <input type="hidden" name="id" value={device.id} />
                {isArmed(device, now) ? (
                  <>
                    <span className="w-full text-xs text-slate-500">Disarm (e.g. for a service visit):</span>
                    {[
                      ["1h", "1 hour"],
                      ["4h", "4 hours"],
                      ["morning", "Until 6 AM"],
                      ["indefinite", "Until re-armed"],
                    ].map(([mode, label]) => (
                      <button
                        key={mode}
                        name="mode"
                        value={mode}
                        className="rounded border border-slate-300 px-2 py-1 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
                      >
                        {label}
                      </button>
                    ))}
                  </>
                ) : (
                  <button name="mode" value="arm" className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
                    Arm now
                  </button>
                )}
              </form>
            </>
          ) : (
            <p className="text-sm text-slate-500">
              Set the service level to Safety &amp; Access Monitoring (under Settings) to get unauthorized-use and check-in alerts
              for this machine.
            </p>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-semibold">Operator check-ins</h2>
            <Link href={`/devices/${encodeURIComponent(device.id)}/qr`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
              Print QR sticker
            </Link>
          </div>
          {current ? (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-slate-50 px-3 py-2 text-sm dark:bg-slate-800/60">
              <span>
                <span className="font-medium">{current.operatorName}</span> checked in since {clockTime(current.startedAt, tz, now)}
                {current.engineOffSince && (
                  <span className="text-slate-500">
                    {" "}
                    · on a break, engine off since {clockTime(current.engineOffSince, tz, now)}
                  </span>
                )}
                <CheckinFlags checkin={current} />
              </span>
              <form action={endCheckinAction}>
                <input type="hidden" name="checkinId" value={current.id} />
                <button className="text-sm text-sky-700 hover:underline dark:text-sky-400">End check-in</button>
              </form>
            </div>
          ) : (
            <p className="text-sm text-slate-500">Nobody is checked in.</p>
          )}
          {history.length > 0 && (
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase text-slate-500">
                <tr>
                  <th className="py-1">Checked in</th>
                  <th className="py-1">Operator</th>
                  <th className="py-1">Until</th>
                  <th className="py-1">At machine</th>
                  <th className="py-1">Engine</th>
                  <th className="py-1">Checklist</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                {history.map((c) => {
                  const failed = c.answers.filter((a) => !a.ok);
                  const where = locationLabel(c);
                  const timing = engineLabel(c.engine);
                  return (
                    <tr key={c.id} className="align-top">
                      <td className="py-1.5">{clockTime(c.startedAt, tz, now)}</td>
                      <td className="py-1.5">
                        {c.operatorName}
                        {!c.authorized && <span className="ml-1 text-xs text-amber-700 dark:text-amber-400">(not approved)</span>}
                      </td>
                      <td className="py-1.5">
                        {c.endedAt ? (
                          <>
                            {clockTime(c.endedAt, tz, now)} <span className="text-xs text-slate-500">{c.endReason}</span>
                          </>
                        ) : c.id === current?.id ? (
                          <span className="text-emerald-700 dark:text-emerald-400">Now</span>
                        ) : (
                          <span className="text-slate-500">No check-out</span>
                        )}
                      </td>
                      <td className={`py-1.5 ${where.warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{where.text}</td>
                      <td className={`py-1.5 ${timing.warn ? "text-amber-700 dark:text-amber-400" : ""}`}>{timing.text}</td>
                      <td className="py-1.5">
                        {failed.length === 0 && !c.notes ? (
                          <span className="text-emerald-700 dark:text-emerald-400">All OK</span>
                        ) : (
                          <details>
                            <summary className={`cursor-pointer ${failed.length ? "text-amber-700 dark:text-amber-400" : ""}`}>
                              {failed.length ? `${failed.length} not OK` : "All OK, with notes"}
                            </summary>
                            <ul className="mt-1 list-disc pl-4 text-xs">
                              {failed.map((a) => (
                                <li key={a.id}>{a.question}</li>
                              ))}
                            </ul>
                            {c.notes && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">“{c.notes}”</p>}
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Approved operators</h2>
          {operators.filter((o) => o.active || allowed.includes(o.id)).length === 0 ? (
            <p className="text-sm text-slate-500">
              No operators yet.{" "}
              <Link href="/operators" className="text-sky-700 hover:underline dark:text-sky-400">
                Add operators
              </Link>
            </p>
          ) : (
            <form key={allowed.join(",")} action={setAllowedOperators} className="space-y-2">
              <input type="hidden" name="id" value={device.id} />
              {operators
                .filter((o) => o.active || allowed.includes(o.id))
                .map((o) => (
                  <label key={o.id} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" name="operator" value={o.id} defaultChecked={allowed.includes(o.id)} />
                    {o.name}
                    {o.employeeNumber && <span className="text-xs text-slate-500">#{o.employeeNumber}</span>}
                    {!o.active && <span className="text-xs text-slate-500">(inactive)</span>}
                  </label>
                ))}
              <p className="text-xs text-slate-500">
                {allowed.length === 0
                  ? "None ticked: any active operator may check in."
                  : "Others can still check in, but are flagged as not approved."}
              </p>
              <button className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">Save</button>
            </form>
          )}
        </section>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Settings</h2>
          {/* key: re-create the form after a save so it shows the saved values */}
          <form key={`${device.name}|${device.tier}`} action={updateDevice} className="space-y-3">
            <input type="hidden" name="id" value={device.id} />
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-400">Machine name</span>
              <input
                name="name"
                defaultValue={device.name ?? ""}
                placeholder="e.g. CAT 320 Excavator #14"
                className="mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
              />
            </label>
            <label className="block text-sm">
              <span className="text-slate-600 dark:text-slate-400">Service level</span>
              <select
                name="tier"
                defaultValue={device.tier}
                className="mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700"
              >
                {tierEnum.enumValues.map((t) => (
                  <option key={t} value={t} disabled={t === "control"}>
                    {TIER_LABELS[t]}
                    {t === "control" ? " (future)" : ""}
                  </option>
                ))}
              </select>
            </label>
            <button className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">Save</button>
          </form>
          {device.vin && <p className="text-sm text-slate-500">VIN: {device.vin}</p>}
        </section>

        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="font-semibold">Latest data</h2>
          {latest ? (
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              {sortFields(latest.fields).map(([key, value]) => (
                <div key={key} className="contents">
                  <dt className="text-slate-500">{key}</dt>
                  <dd className="font-mono">{Array.isArray(value) ? value.join(", ") : value}</dd>
                </div>
              ))}
            </dl>
          ) : (
            <p className="text-sm text-slate-500">No data yet.</p>
          )}
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Connection events</h2>
        {events.length === 0 ? (
          <p className="text-sm text-slate-500">None yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white text-sm dark:divide-slate-800 dark:border-slate-800 dark:bg-slate-900">
            {events.map((e) => (
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

function CheckinFlags({ checkin }: { checkin: Parameters<typeof checkinFlags>[0] }) {
  return (
    <>
      {checkinFlags(checkin).map((flag) => (
        <span key={flag} className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-900/50 dark:text-amber-300">
          {flag}
        </span>
      ))}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
      <div className="text-xs uppercase text-slate-500">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
    </div>
  );
}

const FIELD_ORDER = Object.values(PID_NAMES);

/** Show fields in protocol order (position first, then sensors, then OBD); unknown fields last. */
function sortFields(fields: Record<string, number | number[]>) {
  const rank = (k: string) => (FIELD_ORDER.includes(k) ? FIELD_ORDER.indexOf(k) : FIELD_ORDER.length);
  return Object.entries(fields).sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
