import Link from "next/link";
import { Suspense } from "react";
import { maintenanceMachineChoices, maintenanceScheduleData } from "@/lib/data";
import { clockTime } from "@/lib/format";
import { describeDuePart, describeInterval } from "@/lib/maintenance-types";
import { openServiceNowAction } from "../actions";
import { button, card, MaintenanceHeader, primary } from "../ui";
import { ReadingForm } from "./ScheduleForms";

/** Maintenance → Service schedules: preventive maintenance by hours, km and/or time, and where each machine stands. */
export default function SchedulesPage() {
  return (
    <div className="space-y-5">
      <Suspense fallback={<MaintenanceHeader active="/maintenance/schedules" canEdit={false} />}>
        <Schedules />
      </Suspense>
    </div>
  );
}

const STATE = {
  due: { label: "Due", style: "bg-sky-700 text-white" },
  soon: { label: "Due soon", style: "bg-sky-100 text-sky-800 dark:bg-sky-900/50 dark:text-sky-300" },
  ok: { label: "OK", style: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300" },
  unknown: { label: "Needs a reading", style: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300" },
} as const;

const SOURCE = { engine: "from the engine computer", reading: "as entered", estimated: "estimated: last reading + engine time since" } as const;

async function Schedules() {
  const [{ schedules, now, timeZone, canEdit }, machines] = await Promise.all([maintenanceScheduleData(), maintenanceMachineChoices()]);
  const order = { due: 0, soon: 1, unknown: 2, ok: 3 } as const;
  const sorted = [...schedules].sort((a, b) => Number(!a.active) - Number(!b.active) || order[a.due.state] - order[b.due.state] || a.machineLabel.localeCompare(b.machineLabel));
  return (
    <>
      <MaintenanceHeader active="/maintenance/schedules" canEdit={canEdit} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-slate-500">A service item opens by itself when a schedule comes due. Resolving it sets the next due.</p>
        {canEdit && (
          <Link href="/maintenance/schedules/new" className={primary}>
            + New schedule
          </Link>
        )}
      </div>
      {canEdit && machines.length > 0 && (
        <section className={`${card} space-y-2 p-4`}>
          <h2 className="font-semibold">Record a meter reading</h2>
          <p className="text-xs text-slate-500">
            Machines that don&apos;t send their own hour meter count hours from the latest reading (checklists ask for one every time) plus the
            engine time VS-lab measures.
          </p>
          <ReadingForm machines={machines} />
        </section>
      )}
      {sorted.length === 0 ? (
        <p className={`${card} p-6 text-center text-sm text-slate-500`}>No service schedules yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sorted.map((s) => (
            <section key={s.id} className={`${card} space-y-2 p-4 ${s.active ? "" : "opacity-60"}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold">{s.description}</p>
                  <Link href={`/machines/${s.machineId}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
                    {s.machineLabel}
                  </Link>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${s.active ? STATE[s.due.state].style : ""}`}>{s.active ? STATE[s.due.state].label : "Paused"}</span>
              </div>
              <p className="text-sm">{describeInterval(s)}</p>
              <ul className="space-y-0.5 text-sm text-slate-600 dark:text-slate-400">
                {s.nextDueHours !== null && <li>Next at {s.nextDueHours.toLocaleString("en-CA")} h</li>}
                {s.nextDueKm !== null && <li>Next at {s.nextDueKm.toLocaleString("en-CA")} km</li>}
                {s.nextDueOn && <li>Next by {s.nextDueOn}</li>}
                {s.due.parts.map((p) => (
                  <li key={p.kind} className={p.state === "due" ? "font-medium text-sky-800 dark:text-sky-300" : ""}>
                    {p.kind === "days" ? "Date" : p.kind === "hours" ? "Hours" : "Km"}: {describeDuePart(p)}
                  </li>
                ))}
              </ul>
              <p className="text-xs text-slate-500">
                {s.readings.hours && <>Now {s.readings.hours.value.toLocaleString("en-CA")} h ({SOURCE[s.readings.hours.source]}). </>}
                {s.readings.km && <>Now {s.readings.km.value.toLocaleString("en-CA")} km ({SOURCE[s.readings.km.source]}). </>}
                {s.lastServicedAt && <>Last done {clockTime(s.lastServicedAt, timeZone, now)}.</>}
              </p>
              <div className="flex flex-wrap gap-2 pt-1">
                {s.openIssue ? (
                  <Link href={`/maintenance/issues/${s.openIssue.id}`} className={button}>
                    Open item #{s.openIssue.number}
                  </Link>
                ) : (
                  canEdit && (
                    <form action={openServiceNowAction}>
                      <input type="hidden" name="scheduleId" value={s.id} />
                      <button className={button}>Start service now</button>
                    </form>
                  )
                )}
                {canEdit && (
                  <Link href={`/maintenance/schedules/${s.id}`} className={button}>
                    Edit
                  </Link>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </>
  );
}
