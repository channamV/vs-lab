import { formatHours } from "@/lib/format";

/**
 * Report charts, drawn with plain HTML/CSS (no chart library). Colours from the validated reference
 * palette: working = blue, idle = orange (two series → legend), magnitude = one blue ramp. Every
 * chart has hover details and a hidden table for screen readers.
 */

const WORKING = "bg-[#2a78d6] dark:bg-[#3987e5]";
const IDLE = "bg-[#eb6834] dark:bg-[#d95926]";
const tooltip =
  "pointer-events-none absolute z-10 hidden whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white shadow group-hover:block dark:bg-slate-100 dark:text-slate-900";

/** "Mon 19" from a local date key. */
export function dayLabel(date: string, long = false) {
  const d = new Date(`${date}T12:00:00Z`);
  return new Intl.DateTimeFormat("en-US", long ? { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" } : { timeZone: "UTC", weekday: "short", day: "numeric" }).format(d);
}

/** A clean top value for an hours axis. */
function niceMax(max: number) {
  if (max <= 1) return 1;
  const steps = [2, 4, 5, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80, 100, 120, 150, 200, 250, 300, 400, 500, 1000];
  return steps.find((s) => s >= max) ?? Math.ceil(max / 100) * 100;
}

function Legend({ items }: { items: [string, string][] }) {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-400">
      {items.map(([label, color]) => (
        <span key={label} className="flex items-center gap-1.5">
          <span className={`inline-block h-2.5 w-2.5 rounded-sm ${color}`} />
          {label}
        </span>
      ))}
    </div>
  );
}

/** Engine hours per day, split into working and idle (stacked columns). */
export function DailyHoursChart({ days, idleLabel = "Idle" }: { days: { date: string; working: number; idle: number }[]; idleLabel?: string }) {
  const top = niceMax(Math.max(0, ...days.map((d) => d.working + d.idle)));
  const showEvery = days.length > 31 ? 7 : days.length > 14 ? 2 : 1;
  return (
    <figure className="space-y-3">
      <Legend items={[["Working", WORKING], [idleLabel, IDLE]]} />
      <div className="relative h-48 border-b border-slate-300 dark:border-slate-700" aria-hidden>
        <div className="absolute inset-x-0 top-0 border-t border-slate-200 dark:border-slate-800" />
        <div className="absolute inset-x-0 top-1/2 border-t border-slate-100 dark:border-slate-800/60" />
        <span className="absolute -top-2.5 right-0 bg-white pl-1 text-[11px] tabular-nums text-slate-400 dark:bg-slate-900">{top} h</span>
        <div className="absolute inset-0 flex items-end gap-[2px] pr-8">
          {days.map((d) => (
            <div key={d.date} className="group relative flex h-full flex-1 flex-col items-center justify-end">
              <div className="flex w-full max-w-6 flex-col justify-end gap-[2px]" style={{ height: `${((d.working + d.idle) / top) * 100}%` }}>
                {d.idle > 0 && <div className={`w-full rounded-t-[4px] ${IDLE}`} style={{ height: `${(d.idle / (d.working + d.idle)) * 100}%`, minHeight: 2 }} />}
                {d.working > 0 && (
                  <div className={`w-full ${d.idle > 0 ? "" : "rounded-t-[4px]"} ${WORKING}`} style={{ height: `${(d.working / (d.working + d.idle)) * 100}%`, minHeight: 2 }} />
                )}
              </div>
              <div className={`${tooltip} bottom-full mb-1`}>
                <div className="font-medium">{dayLabel(d.date, true)}</div>
                <div>Working {formatHours(d.working)}</div>
                <div>Idle {formatHours(d.idle)}</div>
                <div>Total {formatHours(d.working + d.idle)}</div>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex gap-[2px] pr-8 text-center text-[11px] text-slate-500" aria-hidden>
        {days.map((d, i) => (
          <div key={d.date} className="flex-1 overflow-visible whitespace-nowrap">
            {i % showEvery === 0 ? dayLabel(d.date) : ""}
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>Engine hours per day</caption>
        <thead>
          <tr>
            <th>Day</th>
            <th>Working</th>
            <th>Idle</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{formatHours(d.working)}</td>
              <td>{formatHours(d.idle)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

/** Hours per machine (or operator): horizontal bars, longest first, value at the tip. */
export function HoursBars({ rows, empty }: { rows: { key: string | number; label: string; hours: number; hint?: string }[]; empty: string }) {
  const max = Math.max(0, ...rows.map((r) => r.hours));
  if (rows.length === 0) return <p className="text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(6rem,11rem)_1fr] items-center gap-3 text-sm">
          <span className="truncate" title={r.label}>
            {r.label}
          </span>
          <span className="flex items-center gap-2">
            {r.hours > 0 && <span className={`h-4 rounded-r-[4px] ${WORKING}`} style={{ width: `${(r.hours / max) * 85}%`, minWidth: 2 }} />}
            <span className="whitespace-nowrap text-xs tabular-nums text-slate-600 dark:text-slate-400">
              {formatHours(r.hours)}
              {r.hint && <span className="text-slate-400"> · {r.hint}</span>}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const HEAT_STEPS: [number, string, string][] = [
  [0, "bg-slate-100 dark:bg-slate-800", "None"],
  [0.5, "bg-[#cde2fb] dark:bg-[#184f95]", "Under 30 min"],
  [2, "bg-[#9ec5f4] dark:bg-[#1c5cab]", "Under 2 h"],
  [5, "bg-[#5598e7] dark:bg-[#2a78d6]", "Under 5 h"],
  [8, "bg-[#256abf] dark:bg-[#5598e7]", "Under 8 h"],
  [Infinity, "bg-[#104281] dark:bg-[#9ec5f4]", "8 h or more"],
];
const heatClass = (hours: number) => (hours <= 0 ? HEAT_STEPS[0][1] : HEAT_STEPS.find(([limit], i) => i > 0 && hours < limit)![1]);

/** Machines × days, shaded by engine hours (like Veristart Insights' Daily Activity). */
export function ActivityHeatmap({ days, rows }: { days: string[]; rows: { id: number; label: string; byDay: Record<string, number> }[] }) {
  return (
    <figure className="space-y-2">
      <div className="overflow-x-auto">
        <table className="border-separate border-spacing-[2px] text-xs">
          <thead>
            <tr>
              <th />
              {days.map((d) => (
                <th key={d} className="w-6 min-w-6 font-normal text-slate-500" title={dayLabel(d, true)}>
                  {Number(d.slice(8))}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id}>
                <th scope="row" className="max-w-40 truncate pr-2 text-left font-normal" title={r.label}>
                  {r.label}
                </th>
                {days.map((d) => {
                  const h = r.byDay[d] ?? 0;
                  return (
                    <td key={d} className={`h-6 w-6 rounded-[3px] ${heatClass(h)}`} title={`${r.label}, ${dayLabel(d, true)}: ${formatHours(h)}`}>
                      <span className="sr-only">{formatHours(h)}</span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs text-slate-500">
        Less
        {HEAT_STEPS.map(([, cls, label]) => (
          <span key={label} title={label} className={`inline-block h-3 w-3 rounded-[2px] ${cls}`} />
        ))}
        More
      </div>
    </figure>
  );
}

/** A ratio against 100% (utilization), on a lighter track of the same blue. */
export function Meter({ value }: { value: number | null }) {
  if (value === null) return <span className="text-slate-400">—</span>;
  return (
    <span className="flex items-center gap-2">
      <span className="h-2 w-20 overflow-hidden rounded-full bg-[#cde2fb] dark:bg-[#184f95]/60">
        <span className={`block h-full rounded-full ${WORKING}`} style={{ width: `${Math.min(1, value) * 100}%` }} />
      </span>
      <span className="tabular-nums">{Math.round(value * 100)}%</span>
    </span>
  );
}
