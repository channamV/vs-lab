import Link from "next/link";
import { hasRole, type AuthContext } from "@/lib/auth";
import { machineChecklist, machineMaintenanceSummary } from "@/lib/data";
import { describeDuePart } from "@/lib/maintenance-types";
import { IssueChip } from "../../maintenance/ui";
import { ReadingForm } from "../../maintenance/schedules/ScheduleForms";
import type { Machine } from "@/lib/db/schema";
import { clockTime } from "@/lib/format";
import { clearLockoutAction, setMachineTemplateAction } from "./actions";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

/** Shown at the top of the machine page while it's locked out for repair. */
export function LockoutBanner({ machine, auth, timeZone, now }: { machine: Machine; auth: AuthContext | null; timeZone: string; now: number }) {
  if (!machine.lockedOutAt) return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border-2 border-red-400 bg-red-50 p-4 text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
      <div>
        <p className="font-semibold">🔒 Locked out for repair since {clockTime(machine.lockedOutAt, timeZone, now)}</p>
        {machine.lockedOutReason && <p className="text-sm">{machine.lockedOutReason}</p>}
        <p className="text-sm">Operators can&apos;t check in until it&apos;s cleared.</p>
      </div>
      {auth && hasRole(auth, "manager") && (
        <form action={clearLockoutAction}>
          <input type="hidden" name="id" value={machine.id} />
          <button className="rounded border border-red-400 bg-white px-3 py-1.5 text-sm font-medium hover:bg-red-100 dark:bg-transparent dark:hover:bg-red-900">
            Repaired: clear lockout
          </button>
        </form>
      )}
    </div>
  );
}

/** Which checklist the machine uses, and its maintenance: open items (checklist defects stack), services, meter readings. */
export async function MachineChecklist({ machine, auth, timeZone, now }: { machine: Machine; auth: AuthContext | null; timeZone: string; now: number }) {
  const [{ templates }, maintenance] = await Promise.all([machineChecklist(machine.id), machineMaintenanceSummary(machine.id)]);
  const canManage = auth !== null && hasRole(auth, "manager");
  const defaultName = templates.find((t) => t.isDefault)?.name;
  const { open, schedules, readings, history } = maintenance;
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Checklist and maintenance</h2>
        {canManage ? (
          <form key={machine.checklistTemplateId ?? "default"} action={setMachineTemplateAction} className="flex items-center gap-2 text-sm">
            <input type="hidden" name="id" value={machine.id} />
            <label className="text-slate-600 dark:text-slate-400" htmlFor="templateId">
              Checklist
            </label>
            <select
              id="templateId"
              name="templateId"
              defaultValue={machine.checklistTemplateId ?? ""}
              className="rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700"
            >
              <option value="">Company default ({defaultName})</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <button className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">Save</button>
            <Link href="/checklists" className="text-sky-700 hover:underline dark:text-sky-400">
              Edit checklists
            </Link>
          </form>
        ) : (
          <span className="text-sm text-slate-500">
            Checklist: {templates.find((t) => t.id === machine.checklistTemplateId)?.name ?? `${defaultName} (company default)`}
          </span>
        )}
      </div>

      {open.length === 0 ? (
        <p className="text-sm text-slate-500">No open maintenance items.</p>
      ) : (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
          {open.map((i) => (
            <IssueChip key={i.id} issue={i} />
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
        <div className="space-y-1">
          <h3 className="font-medium">Meter</h3>
          <p className="text-slate-600 dark:text-slate-400">
            {readings.hours ? `${readings.hours.value.toLocaleString("en-CA")} h (${METER_SOURCE[readings.hours.source]})` : "No hour meter reading yet."}
            {readings.km && <> · {readings.km.value.toLocaleString("en-CA")} km ({METER_SOURCE[readings.km.source]})</>}
          </p>
          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-xs text-slate-500">Recent readings</summary>
              <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
                {history.map((r) => (
                  <li key={r.id}>
                    {clockTime(r.recordedAt, timeZone, now)}: {r.value.toLocaleString("en-CA")} {r.kind === "km" ? "km" : "h"} ({r.source === "checklist" ? "checklist" : r.source === "service" ? "at a service" : "entered by staff"})
                  </li>
                ))}
              </ul>
            </details>
          )}
          {canManage && <ReadingForm fixedMachine={{ id: machine.id, name: machine.name, unitNumber: machine.unitNumber, onRoad: machine.onRoad }} />}
        </div>
        <div className="space-y-1">
          <h3 className="font-medium">Service schedules</h3>
          {schedules.length === 0 ? (
            <p className="text-slate-500">None.</p>
          ) : (
            <ul className="space-y-0.5">
              {schedules.map((s) => (
                <li key={s.id}>
                  <Link href={canManage ? `/maintenance/schedules/${s.id}` : "/maintenance/schedules"} className="text-sky-700 hover:underline dark:text-sky-400">
                    {s.description}
                  </Link>{" "}
                  <span className={s.due.state === "due" ? "font-medium text-sky-800 dark:text-sky-300" : "text-slate-500"}>
                    · {!s.active ? "paused" : s.due.state === "unknown" ? "needs a reading" : s.due.parts.map(describeDuePart).join(", ")}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {canManage && (
            <p className="flex flex-wrap gap-3">
              <Link href={`/maintenance/schedules/new?machine=${machine.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                + Service schedule
              </Link>
              <Link href={`/maintenance/issues/new?machine=${machine.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                + Maintenance item
              </Link>
            </p>
          )}
        </div>
      </div>
      <p className="text-xs text-slate-500">
        Checklist defects open maintenance items; a defect reported again is added to its open item rather than listed again.{" "}
        <Link href="/maintenance" className="text-sky-700 hover:underline dark:text-sky-400">
          All maintenance →
        </Link>
      </p>
    </section>
  );
}

const METER_SOURCE = { engine: "engine computer", reading: "as entered", estimated: "estimated from engine time" } as const;
