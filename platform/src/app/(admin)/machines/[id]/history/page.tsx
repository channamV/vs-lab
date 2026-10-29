import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getMachine, machineLocationHistory, worksiteOutlines } from "@/lib/data";
import { formatHours, machineLabel } from "@/lib/format";
import { HISTORY_MAX_DAYS, HISTORY_PRESETS } from "@/lib/history-track";
import { HistoryReplay } from "./HistoryReplay";

/** Location history and replay for one machine (docs/location-history.md). */
export default function HistoryPage({ params, searchParams }: PageProps<"/machines/[id]/history">) {
  return (
    <div className="space-y-5">
      <Suspense fallback={<p className="text-sm text-slate-500">Loading location history…</p>}>
        <History params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function History({ params, searchParams }: Pick<PageProps<"/machines/[id]/history">, "params" | "searchParams">) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const machine = await getMachine(id);
  if (!machine) notFound();
  const sp = await searchParams;
  const str = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
  const [{ range, timeZone, history }, sites] = await Promise.all([
    machineLocationHistory(id, { range: str("range"), from: str("from"), to: str("to") }),
    worksiteOutlines(),
  ]);
  const s = history.summary;
  const query = range.preset === "custom" ? `range=custom&from=${range.fromInput}&to=${range.toInput}` : `range=${range.preset}`;
  return (
    <>
      <div>
        <Link href={`/machines/${id}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← {machineLabel(machine)}
        </Link>
        <h1 className="text-2xl font-semibold">Location history</h1>
        <p className="text-sm text-slate-500">
          {range.label} · times in {timeZone}
        </p>
      </div>

      <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
        <div className="flex flex-wrap gap-2 text-sm">
          {Object.entries(HISTORY_PRESETS).map(([key, label]) => (
            <Link
              key={key}
              href={`?range=${key}`}
              className={`rounded-full border px-3 py-1 ${range.preset === key ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 dark:border-slate-700"}`}
            >
              {label}
            </Link>
          ))}
        </div>
        <form className="flex flex-wrap items-end gap-2 text-sm">
          <input type="hidden" name="range" value="custom" />
          <label className="block">
            <span className="text-slate-600 dark:text-slate-400">From</span>
            <input type="datetime-local" name="from" defaultValue={range.fromInput} required className="mt-1 block rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700" />
          </label>
          <label className="block">
            <span className="text-slate-600 dark:text-slate-400">To</span>
            <input type="datetime-local" name="to" defaultValue={range.toInput} required className="mt-1 block rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700" />
          </label>
          <button className={`rounded px-3 py-1.5 font-medium ${range.preset === "custom" ? "bg-sky-700 text-white" : "border border-slate-300 dark:border-slate-700"}`}>
            Show custom range
          </button>
          <span className="text-xs text-slate-500">Up to {HISTORY_MAX_DAYS} days.</span>
        </form>
      </div>

      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-5">
        {[
          ["Distance", `${s.distanceKm < 10 ? s.distanceKm.toFixed(1) : Math.round(s.distanceKm)} km`],
          ["Engine running", formatHours(s.engineMinutes / 60)],
          ["Stops", String(s.stops)],
          ["Top speed", `${Math.round(s.maxKph)} km/h`],
          ["Positions", s.positions.toLocaleString("en-CA")],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <dt className="text-xs text-slate-500 uppercase">{label}</dt>
            <dd className="font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
      {s.thinnedToSeconds && (
        <p className="text-xs text-slate-500">
          Long period: showing one position every {s.thinnedToSeconds >= 120 ? `${Math.round(s.thinnedToSeconds / 60)} min` : `${s.thinnedToSeconds} s`}. Choose a shorter
          period for every detail (short stops may not show).
        </p>
      )}

      <HistoryReplay
        points={history.points}
        segmentStarts={history.segmentStarts}
        stops={history.stops}
        operators={history.operators}
        sites={sites}
        timeZone={timeZone}
      />
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <a href={`/machines/${id}/history/export?${query}`} className="text-sky-700 hover:underline dark:text-sky-400">
          Download positions (CSV)
        </a>
        <a href={`/machines/${id}/history/readings?${query}`} className="text-sky-700 hover:underline dark:text-sky-400">
          Download engine readings (CSV): fuel level, RPM, odometer, battery
        </a>
      </div>
    </>
  );
}
