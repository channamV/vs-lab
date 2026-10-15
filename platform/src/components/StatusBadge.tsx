import type { ConnectionStatus } from "@/lib/data";

const STYLES: Record<ConnectionStatus, { label: string; className: string }> = {
  online: { label: "Online", className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300" },
  recent: { label: "Seen recently", className: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300" },
  offline: { label: "Offline", className: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
};

export function StatusBadge({ status }: { status: ConnectionStatus }) {
  const { label, className } = STYLES[status];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${className}`}>{label}</span>;
}
