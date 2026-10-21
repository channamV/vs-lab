import { machineEngineData, requestTime } from "@/lib/data";
import { clockTime, timeAgo } from "@/lib/format";
import { num } from "@/lib/freematics/protocol";
import { describeFault, lampsText } from "@/lib/j1939";
import { appTimeZone } from "@/lib/telemetry/engine";

/** Engine computer (J1939) readings and fault codes. Only shown for machines whose device reads them. */
export async function EngineData({ machineId, hourMeter }: { machineId: number; hourMeter: number | null }) {
  const [{ latest, faults }, now] = await Promise.all([machineEngineData(machineId), requestTime()]);
  if (!latest && faults.length === 0 && hourMeter === null) return null;
  const f = latest?.fields ?? {};
  const value = (name: string, digits: number, unit: string) => {
    const v = num(f, name);
    return v === null ? "—" : `${v.toLocaleString("en-CA", { maximumFractionDigits: digits })}${unit}`;
  };
  const active = faults.filter((x) => !x.clearedAt);
  const past = faults.filter((x) => x.clearedAt);
  const tz = appTimeZone();
  const readings: [string, string][] = [
    ["Hour meter", hourMeter === null ? "—" : `${hourMeter.toLocaleString("en-CA", { maximumFractionDigits: 1 })} h`],
    ["Fuel rate", value("j1939FuelRateLph", 1, " L/h")],
    ["Total fuel used", value("j1939TotalFuelL", 0, " L")],
    ["Coolant", value("j1939CoolantTempC", 0, " °C")],
    ["Engine load", value("j1939EngineLoadPct", 0, "%")],
    ["DEF level", value("j1939DefLevelPct", 0, "%")],
  ];
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Engine computer (J1939)</h2>
        {latest && <span className="text-xs text-slate-500">Last reading {timeAgo(latest.receivedAt, now)}</span>}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {readings.map(([label, v]) => (
          <div key={label}>
            <dt className="text-xs uppercase text-slate-500">{label}</dt>
            <dd className="font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <h3 className="text-sm font-medium">
          Active fault codes{" "}
          <span className={active.length ? "text-red-700 dark:text-red-400" : "text-slate-500"}>({active.length})</span>
        </h3>
        {active.length === 0 ? (
          <p className="text-sm text-slate-500">None.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {active.map((x) => (
              <li key={x.id}>
                <span className="mr-1 text-red-700 dark:text-red-400" aria-hidden>
                  ⚠
                </span>
                {describeFault(x)}
                <span className="text-slate-500">
                  {" "}
                  · since {clockTime(x.firstSeenAt, tz, now)}
                  {lampsText(x.lamps) && ` · ${lampsText(x.lamps)}`}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
      {past.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500">Recently cleared ({past.length})</summary>
          <ul className="mt-1 space-y-0.5">
            {past.map((x) => (
              <li key={x.id}>
                {describeFault(x)}{" "}
                <span className="text-slate-500">
                  · {clockTime(x.firstSeenAt, tz, now)} – {clockTime(x.clearedAt!, tz, now)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
