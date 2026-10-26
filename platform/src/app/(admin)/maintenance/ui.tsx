import Link from "next/link";
import { PRIORITIES, SOURCES, STATUSES, type Priority, type Source, type Status } from "@/lib/maintenance-types";

/** Pieces shared by the maintenance pages (server components). */

export const card = "rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900";
export const button =
  "inline-flex items-center justify-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800";
export const primary = "inline-flex items-center justify-center gap-1 rounded-lg bg-sky-700 px-4 py-2 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-50";
export const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900";

export function PriorityBadge({ priority, resolved = false }: { priority: string; resolved?: boolean }) {
  const p = PRIORITIES[priority as Priority];
  if (resolved) {
    return (
      <span className="inline-flex items-center rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300">
        ✓ {p?.label ?? priority} · resolved
      </span>
    );
  }
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${p?.style ?? ""}`}>{p?.label ?? priority}</span>;
}

export const statusLabel = (s: string) => STATUSES[s as Status]?.label ?? s;
export const sourceLabel = (s: string) => SOURCES[s as Source] ?? s;
export const SOURCE_ICON: Record<string, string> = { checklist: "📋", schedule: "🛠️", connectivity: "📡", manual: "✍️" };

/** "today", "3d", "5w" since a date. */
export function age(from: Date, now: number) {
  const days = Math.floor((now - from.getTime()) / 86_400_000);
  return days < 1 ? "today" : days < 35 ? `${days}d` : `${Math.floor(days / 7)}w`;
}

const TABS = [
  { href: "/maintenance", label: "By machine" },
  { href: "/maintenance/issues", label: "Issues" },
  { href: "/maintenance/schedules", label: "Service schedules" },
  { href: "/maintenance/history", label: "History" },
] as const;

/** Page header with the maintenance tabs (they scroll sideways on a phone rather than wrapping). */
export function MaintenanceHeader({ active, canEdit }: { active: (typeof TABS)[number]["href"]; canEdit: boolean }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Maintenance</h1>
        {canEdit && (
          <Link href="/maintenance/issues/new" className={primary}>
            + New item
          </Link>
        )}
      </div>
      <nav className="-mx-4 flex gap-1 overflow-x-auto border-b border-slate-200 px-4 sm:mx-0 sm:px-0 dark:border-slate-800" aria-label="Maintenance">
        {TABS.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            aria-current={t.href === active ? "page" : undefined}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm whitespace-nowrap ${
              t.href === active
                ? "border-sky-700 font-medium text-sky-800 dark:border-sky-400 dark:text-sky-300"
                : "border-transparent text-slate-600 hover:text-slate-900 dark:text-slate-400 dark:hover:text-white"
            }`}
          >
            {t.label}
          </Link>
        ))}
      </nav>
    </div>
  );
}

/** A tappable item pill: number + title, in its priority colour. */
export function IssueChip({ issue }: { issue: { id: number; number: number; title: string; priority: string } }) {
  const p = PRIORITIES[issue.priority as Priority];
  return (
    <Link
      href={`/maintenance/issues/${issue.id}`}
      className={`flex min-h-11 items-center gap-2 rounded-lg px-3 py-2 text-sm hover:opacity-90 ${p?.style ?? ""}`}
    >
      <span className="font-mono text-xs opacity-80">#{issue.number}</span>
      <span className="min-w-0 truncate">{issue.title}</span>
    </Link>
  );
}

/** One item as a card (board columns, lists). */
export function IssueCard({
  issue,
  now,
}: {
  issue: { id: number; number: number; title: string; priority: string; source: string; firstReportedAt: Date; resolvedAt: Date | null; reportCount: number; machineName: string; unitNumber: string | null; thumb: string | null; photoCount: number };
  now: number;
}) {
  return (
    <Link href={`/maintenance/issues/${issue.id}`} className={`${card} flex gap-3 p-3 hover:border-sky-400 dark:hover:border-sky-700`}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-mono text-xs text-slate-500">#{issue.number}</span>
          <PriorityBadge priority={issue.priority} resolved={issue.resolvedAt !== null} />
        </div>
        <p className="line-clamp-2 font-medium">{issue.title}</p>
        <p className="truncate text-xs text-slate-500">{issue.unitNumber ? `Unit ${issue.unitNumber} · ${issue.machineName}` : issue.machineName}</p>
        <p className="text-xs text-slate-500">
          {SOURCE_ICON[issue.source]} {sourceLabel(issue.source)}
          {issue.reportCount > 1 && ` · reported ${issue.reportCount}×`} · {age(issue.firstReportedAt, now)}
        </p>
      </div>
      {issue.thumb && (
        <div className="relative shrink-0">
          {/* eslint-disable-next-line @next/next/no-img-element -- private photo served by /photos or /maintenance/files */}
          <img src={issue.thumb} alt="" loading="lazy" className="h-14 w-14 rounded-lg object-cover" />
          {issue.photoCount > 1 && (
            <span className="absolute -right-1 -bottom-1 rounded-full bg-slate-800 px-1.5 text-[10px] text-white">+{issue.photoCount - 1}</span>
          )}
        </div>
      )}
    </Link>
  );
}
