"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { voltageRuns, type VoltagePoint } from "@/lib/history-track";

/**
 * Battery voltage over time (one series): the band is each time slice's lowest–highest reading (so a cranking dip
 * or a short sag is never averaged away), the line its average. Engine-on periods are shaded (charging reads
 * ~13.8–14.4 V, resting ~12.4–12.7 V on 12 V systems). Breaks where the device wasn't reporting. Hover for details;
 * a hidden table for screen readers. Colours: the validated blue (reports), warning amber for the low line.
 */

const H = 240;
const M = { top: 12, right: 64, bottom: 24, left: 50 };

type Props = {
  points: VoltagePoint[];
  bucketSeconds: number;
  engine: { from: number; to: number }[];
  from: number;
  to: number;
  lowThreshold: number | null;
  system: 12 | 24 | null;
  timeZone: string;
};

const fmtV = (v: number) => `${v.toFixed(2)} V`;

export function VoltageChart({ points, bucketSeconds, engine, from, to, lowThreshold, system, timeZone }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(280, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const bucketMs = bucketSeconds * 1000;
  const runs = useMemo(() => voltageRuns(points, bucketMs), [points, bucketMs]);
  const [lo, hi] = useMemo(() => {
    const base = system === 24 ? [22, 29] : [11, 14.5];
    const min = Math.min(base[0], ...points.map((p) => p.min), (lowThreshold ?? base[0]) - 0.5);
    const max = Math.max(base[1], ...points.map((p) => p.max));
    const step = max - min > 8 ? 2 : max - min > 4 ? 1 : 0.5;
    return [Math.floor(min / step) * step, Math.ceil(max / step) * step];
  }, [points, lowThreshold, system]);

  const plotW = width - M.left - M.right;
  const plotH = H - M.top - M.bottom;
  const x = (t: number) => M.left + ((t - from) / (to - from)) * plotW;
  const y = (v: number) => M.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const mid = (p: VoltagePoint) => p.t + bucketMs / 2;

  const yStep = hi - lo > 8 ? 2 : hi - lo > 4 ? 1 : 0.5;
  const yTicks: number[] = [];
  for (let v = lo; v <= hi + 1e-9; v += yStep) yTicks.push(Math.round(v * 10) / 10);
  const spanDays = (to - from) / 86_400_000;
  const tickFmt = new Intl.DateTimeFormat("en-CA", spanDays <= 1.5 ? { timeZone, hour: "numeric", minute: "2-digit" } : { timeZone, month: "short", day: "numeric" });
  const tickCount = Math.max(2, Math.min(7, Math.floor(plotW / 110)));
  const xTicks = Array.from({ length: tickCount }, (_, i) => from + ((to - from) * i) / (tickCount - 1));
  const timeFmt = new Intl.DateTimeFormat("en-CA", { timeZone, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

  const area = (run: VoltagePoint[]) =>
    run.length === 1
      ? ""
      : `M${run.map((p) => `${x(mid(p))},${y(p.max)}`).join("L")}L${[...run].reverse().map((p) => `${x(mid(p))},${y(p.min)}`).join("L")}Z`;
  const line = (run: VoltagePoint[]) => `M${run.map((p) => `${x(mid(p))},${y(p.avg)}`).join("L")}`;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!points.length) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const t = from + ((e.clientX - rect.left - M.left) / plotW) * (to - from);
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(mid(points[i]) - t) < Math.abs(mid(points[best]) - t)) best = i;
    setHover(Math.abs(x(mid(points[best])) - (e.clientX - rect.left)) < 40 ? best : null);
  };
  const h = hover === null ? null : points[hover];

  return (
    <figure className="space-y-2">
      <div className="flex flex-wrap gap-4 text-xs text-slate-600 dark:text-slate-400">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-4 bg-[#2a78d6] dark:bg-[#3987e5]" /> Average
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-[#2a78d6]/25 dark:bg-[#3987e5]/30" /> Lowest–highest
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-slate-200 dark:bg-slate-700" /> Engine running
        </span>
        {lowThreshold !== null && (
          <span className="flex items-center gap-1.5">
            <span className="inline-block w-4 border-t-2 border-dashed border-amber-600" /> Low battery ({lowThreshold} V)
          </span>
        )}
      </div>
      <div ref={box} className="relative" aria-hidden>
        <svg width={width} height={H} onMouseMove={onMove} onMouseLeave={() => setHover(null)} className="block touch-none select-none">
          {engine.map((s, i) => (
            <rect key={i} x={x(s.from)} y={M.top} width={Math.max(1, x(s.to) - x(s.from))} height={plotH} className="fill-slate-200 dark:fill-slate-700/70" />
          ))}
          {yTicks.map((v) => (
            <g key={v}>
              <line x1={M.left} x2={M.left + plotW} y1={y(v)} y2={y(v)} className="stroke-slate-200 dark:stroke-slate-800" strokeWidth={1} />
              <text x={M.left - 6} y={y(v) + 4} textAnchor="end" className="fill-slate-500 text-[11px] tabular-nums">
                {v} V
              </text>
            </g>
          ))}
          {xTicks.map((t, i) => (
            <text key={t} x={x(t)} y={H - 6} textAnchor={i === 0 ? "start" : i === xTicks.length - 1 ? "end" : "middle"} className="fill-slate-500 text-[11px]">
              {tickFmt.format(new Date(t))}
            </text>
          ))}
          {lowThreshold !== null && lowThreshold > lo && lowThreshold < hi && (
            <g>
              <line x1={M.left} x2={M.left + plotW} y1={y(lowThreshold)} y2={y(lowThreshold)} className="stroke-amber-600" strokeWidth={1.5} strokeDasharray="5 4" />
              <text x={M.left + plotW + 6} y={y(lowThreshold) + 4} className="fill-slate-500 text-[11px]">
                Low {lowThreshold} V
              </text>
            </g>
          )}
          {runs.map((run, i) => (
            <g key={i}>
              <path d={area(run)} className="fill-[#2a78d6]/25 dark:fill-[#3987e5]/30" />
              {run.length > 1 ? (
                <path d={line(run)} fill="none" className="stroke-[#2a78d6] dark:stroke-[#3987e5]" strokeWidth={2} strokeLinejoin="round" />
              ) : (
                <circle cx={x(mid(run[0]))} cy={y(run[0].avg)} r={3} className="fill-[#2a78d6] dark:fill-[#3987e5]" />
              )}
            </g>
          ))}
          {h && (
            <g>
              <line x1={x(mid(h))} x2={x(mid(h))} y1={M.top} y2={M.top + plotH} className="stroke-slate-400" strokeWidth={1} />
              <circle cx={x(mid(h))} cy={y(h.avg)} r={4} className="fill-[#2a78d6] stroke-white dark:fill-[#3987e5] dark:stroke-slate-900" strokeWidth={2} />
            </g>
          )}
        </svg>
        {h && (
          <div
            className="pointer-events-none absolute top-2 z-10 rounded bg-slate-900 px-2 py-1 text-xs whitespace-nowrap text-white shadow dark:bg-slate-100 dark:text-slate-900"
            style={x(mid(h)) > width / 2 ? { right: width - x(mid(h)) + 8 } : { left: x(mid(h)) + 8 }}
          >
            <div className="font-medium">
              {timeFmt.format(new Date(h.t))}
              {bucketSeconds > 60 ? ` – ${timeFmt.format(new Date(h.t + bucketMs)).replace(/^.*?, /, "")}` : ""}
            </div>
            <div>Average {fmtV(h.avg)}</div>
            <div>
              Lowest {fmtV(h.min)} · highest {fmtV(h.max)}
            </div>
            <div>
              {h.n} reading{h.n === 1 ? "" : "s"}
              {h.engineOn ? " · engine running" : ""}
            </div>
          </div>
        )}
      </div>
      <table className="sr-only">
        <caption>Battery voltage</caption>
        <thead>
          <tr>
            <th>From</th>
            <th>Average</th>
            <th>Lowest</th>
            <th>Highest</th>
            <th>Engine running</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.t}>
              <td>{timeFmt.format(new Date(p.t))}</td>
              <td>{fmtV(p.avg)}</td>
              <td>{fmtV(p.min)}</td>
              <td>{fmtV(p.max)}</td>
              <td>{p.engineOn ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
