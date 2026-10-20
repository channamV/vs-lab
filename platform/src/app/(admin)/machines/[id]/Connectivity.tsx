import { machineIncidents } from "@/lib/data";
import { INCIDENT_LABELS, TAMPER_RULES } from "@/lib/tamper";
import { clockTime } from "@/lib/format";

const PILL: Record<string, string> = {
  high: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300",
  low: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};

export function ConcernPill({ concern }: { concern: string }) {
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${PILL[concern] ?? PILL.low}`}>{concern} concern</span>;
}

/** The machine's tracking-device incidents: quiet spells, power cuts, moved while quiet, different vehicle. */
export async function Connectivity({ machineId, timeZone, now }: { machineId: number; timeZone: string; now: number }) {
  const incidents = await machineIncidents(machineId);
  return (
    <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <h2 className="font-semibold">Connectivity and tamper</h2>
      {incidents.length === 0 ? (
        <p className="text-sm text-slate-500">No problems with the tracking device.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {incidents.map((i) => (
            <li key={i.id} className="space-y-1 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{INCIDENT_LABELS[i.kind] ?? i.kind}</span>
                <ConcernPill concern={i.concern} />
                <span className="text-xs text-slate-500">
                  {clockTime(i.openedAt, timeZone, now)} · device {i.deviceId}
                </span>
                {i.kind === "silent" && !i.resolvedAt && (
                  <span className="text-xs font-medium text-red-700 dark:text-red-400">still quiet</span>
                )}
              </div>
              <ul className="list-disc pl-5 text-xs text-slate-600 dark:text-slate-400">
                {i.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
              {i.resolution && <p className="text-xs text-emerald-700 dark:text-emerald-400">{i.resolution}</p>}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-slate-500">
        A healthy device reports every few seconds while the machine runs, and checks in every {TAMPER_RULES.heartbeatMinutes} minutes
        while it&apos;s parked. Silences longer than that are scored low, medium or high concern from how it went quiet.
      </p>
    </section>
  );
}
