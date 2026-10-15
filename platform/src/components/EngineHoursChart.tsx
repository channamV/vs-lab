import type { DayHours } from "@/lib/telemetry/engine";
import { formatHours } from "@/lib/format";

/**
 * Engine hours per day — single series, so one hue, no legend (the heading names it).
 * Today's bar is labelled; every bar shows its value on hover and in the screen-reader table.
 */
export function EngineHoursChart({ days, timeZone }: { days: DayHours[]; timeZone: string }) {
  const max = Math.max(1, ...days.map((d) => d.hours));
  const scaleMax = Math.ceil(max);
  // "Mon 12" — the date key is already local, so format it as a plain calendar date.
  const label = (date: string) => {
    const d = new Date(`${date}T12:00:00Z`);
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short" }).format(d);
    return `${weekday} ${d.getUTCDate()}`;
  };
  const total = days.reduce((sum, d) => sum + d.hours, 0);

  return (
    <figure className="space-y-3">
      <figcaption className="flex items-baseline justify-between text-sm">
        <span className="text-slate-500">Last {days.length} days ({timeZone.replace("_", " ")})</span>
        <span>
          <span className="text-slate-500">Total </span>
          <span className="font-semibold">{formatHours(total)}</span>
        </span>
      </figcaption>

      <div className="relative h-40 border-b border-slate-300 dark:border-slate-700" aria-hidden>
        {/* recessive gridline at the top of the scale */}
        <div className="absolute inset-x-0 top-0 border-t border-dashed border-slate-200 dark:border-slate-800" />
        <span className="absolute -top-2.5 right-0 bg-white pl-1 text-[11px] text-slate-400 dark:bg-slate-900">
          {scaleMax} h
        </span>
        <div className="absolute inset-0 flex items-end gap-[2px] px-1">
          {days.map((d, i) => {
            const isToday = i === days.length - 1;
            return (
              <div key={d.date} className="group relative flex h-full flex-1 items-end justify-center">
                <div
                  className="w-full max-w-10 rounded-t bg-sky-600 transition-opacity group-hover:opacity-80 dark:bg-sky-400"
                  style={{ height: `${(d.hours / scaleMax) * 100}%`, minHeight: d.hours > 0 ? 2 : 0 }}
                />
                {/* hover tooltip — hit target is the whole column, not just the bar */}
                <div className="pointer-events-none absolute bottom-full mb-1 hidden whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-xs text-white group-hover:block dark:bg-slate-100 dark:text-slate-900">
                  {label(d.date)}: {formatHours(d.hours)}
                </div>
                {isToday && d.hours > 0 && (
                  <span
                    className="absolute text-xs font-medium text-slate-700 group-hover:hidden dark:text-slate-200"
                    style={{ bottom: `calc(${(d.hours / scaleMax) * 100}% + 4px)` }}
                  >
                    {formatHours(d.hours)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex gap-[2px] px-1 text-center text-[11px] text-slate-500" aria-hidden>
        {days.map((d, i) => (
          <div key={d.date} className={`flex-1 ${i === days.length - 1 ? "font-semibold text-slate-700 dark:text-slate-200" : ""}`}>
            {i === days.length - 1 ? "Today" : label(d.date)}
          </div>
        ))}
      </div>

      <table className="sr-only">
        <caption>Engine hours per day</caption>
        <tbody>
          {days.map((d) => (
            <tr key={d.date}>
              <th scope="row">{d.date}</th>
              <td>{formatHours(d.hours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
