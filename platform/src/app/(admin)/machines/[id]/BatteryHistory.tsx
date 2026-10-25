import Link from "next/link";
import { machineVoltage } from "@/lib/data";
import { VoltageChart } from "@/components/VoltageChart";

const RANGES = [
  ["24h", "24 hours"],
  ["7d", "7 days"],
  ["30d", "30 days"],
] as const;

/** Battery voltage history on a machine's page (docs/location-history.md → Battery voltage). */
export async function BatteryHistory({ machineId, range }: { machineId: number; range: string | undefined }) {
  const { range: r, timeZone, history } = await machineVoltage(machineId, range);
  const s = history.summary;
  const time = new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const v = (x: number | null) => (x === null ? "—" : `${x.toFixed(2)} V`);
  return (
    <section id="battery" className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">
          Battery voltage {s.system && <span className="text-sm font-normal text-slate-500">· {s.system} V system</span>}
        </h2>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {RANGES.map(([key, label]) => (
            <Link
              key={key}
              href={`?battery=${key}#battery`}
              scroll={false}
              className={`rounded-full border px-3 py-0.5 ${r.preset === key ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 dark:border-slate-700"}`}
            >
              {label}
            </Link>
          ))}
          <a href={`/machines/${machineId}/battery/export?battery=${r.preset}`} className="text-sky-700 hover:underline dark:text-sky-400">
            CSV
          </a>
        </div>
      </div>
      {s.readings === 0 ? (
        <p className="text-sm text-slate-500">No battery readings in the last {RANGES.find(([k]) => k === r.preset)?.[1] ?? "period"}.</p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-slate-500 uppercase">Latest</dt>
              <dd className="font-semibold tabular-nums">{v(s.latest?.v ?? null)}</dd>
              {s.latest && <dd className="text-xs text-slate-500">{time.format(new Date(s.latest.at))}</dd>}
            </div>
            <div>
              <dt className="text-xs text-slate-500 uppercase">Lowest</dt>
              <dd className="font-semibold tabular-nums">{v(s.min)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 uppercase">Highest</dt>
              <dd className="font-semibold tabular-nums">{v(s.max)}</dd>
            </div>
            <div>
              <dt className="text-xs text-slate-500 uppercase">Average</dt>
              <dd className="font-semibold tabular-nums">{v(s.avg)}</dd>
              <dd className="text-xs text-slate-500">{s.readings.toLocaleString("en-CA")} readings</dd>
            </div>
          </dl>
          <VoltageChart
            points={history.points}
            bucketSeconds={history.bucketSeconds}
            engine={history.engine}
            from={r.from}
            to={r.to}
            lowThreshold={s.lowThreshold}
            system={s.system}
            timeZone={timeZone}
          />
        </>
      )}
      <p className="text-xs text-slate-500">
        A brief dip below the low line while the engine cranks is normal. The device reports while the machine runs or moves; readings while it&apos;s
        parked overnight need a firmware update (planned).
      </p>
    </section>
  );
}
