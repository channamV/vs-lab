import type { EngineStatus } from "@/lib/data";

const STYLES: Record<EngineStatus, { label: string; dot: string; className: string }> = {
  running: {
    label: "Running",
    dot: "bg-emerald-500",
    className: "bg-emerald-50 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  off: { label: "Off", dot: "bg-slate-400", className: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
  stale: {
    label: "No recent data",
    dot: "bg-amber-500",
    className: "bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  },
  unknown: { label: "Unknown", dot: "bg-slate-300", className: "text-slate-500" },
};

export function EngineBadge({ status }: { status: EngineStatus }) {
  const { label, dot, className } = STYLES[status];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {label}
    </span>
  );
}
