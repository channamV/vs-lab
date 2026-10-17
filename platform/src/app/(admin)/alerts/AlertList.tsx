import Link from "next/link";
import { ALERT_LABELS, type AlertType } from "@/lib/alerts";
import { clockTime, machineLabel } from "@/lib/format";
import { acknowledgeAction } from "./actions";

type AlertRow = {
  id: number;
  machineId: number;
  machineName: string;
  unitNumber: string | null;
  type: string;
  createdAt: Date;
  title: string;
  detail: string | null;
  acknowledgedAt: Date | null;
  ackNote: string | null;
  emailStatus: string | null;
  emailError: string | null;
};

const EMAIL_STATUS: Record<string, string> = {
  sent: "Emailed",
  failed: "Email failed",
  "not-configured": "Not emailed (email not set up)",
};

/** A list of alerts, with an Acknowledge form on open ones. Shared by the Alerts and machine pages. */
export function AlertList({ alerts, timeZone, now, showMachine = true }: { alerts: AlertRow[]; timeZone: string; now: number; showMachine?: boolean }) {
  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800">
      {alerts.map((a) => (
        <li key={a.id} className="space-y-1.5 py-3">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span
              className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                a.type === "unauthorized-use"
                  ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300"
                  : "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
              }`}
            >
              {ALERT_LABELS[a.type as AlertType] ?? a.type}
            </span>
            {showMachine && (
              <Link href={`/machines/${a.machineId}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
                {machineLabel({ name: a.machineName, unitNumber: a.unitNumber })}
              </Link>
            )}
            <span className="text-slate-500">{clockTime(a.createdAt, timeZone, now)}</span>
            {a.emailStatus && (
              <span className={`text-xs ${a.emailStatus === "sent" ? "text-slate-500" : "text-amber-700 dark:text-amber-400"}`} title={a.emailError ?? undefined}>
                · {EMAIL_STATUS[a.emailStatus] ?? a.emailStatus}
              </span>
            )}
          </div>
          {a.detail && <p className="text-sm">{a.detail}</p>}
          {a.acknowledgedAt ? (
            <p className="text-xs text-slate-500">
              Acknowledged {clockTime(a.acknowledgedAt, timeZone, now)}
              {a.ackNote && <>: “{a.ackNote}”</>}
            </p>
          ) : (
            <form action={acknowledgeAction} className="flex flex-wrap gap-2">
              <input type="hidden" name="alertId" value={a.id} />
              <input
                name="note"
                maxLength={500}
                placeholder="Note (optional), e.g. mechanic testing"
                className="min-w-0 flex-1 rounded border border-slate-300 bg-transparent px-2 py-1 text-sm dark:border-slate-700"
              />
              <button className="rounded bg-sky-700 px-3 py-1 text-sm font-medium text-white hover:bg-sky-800">Acknowledge</button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}
