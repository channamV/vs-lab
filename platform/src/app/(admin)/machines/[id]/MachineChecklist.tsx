import Link from "next/link";
import { hasRole, type AuthContext } from "@/lib/auth";
import { machineChecklist } from "@/lib/data";
import type { Machine } from "@/lib/db/schema";
import { clockTime } from "@/lib/format";
import { clearLockoutAction, resolveIssueAction, setMachineTemplateAction } from "./actions";

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

/** Which checklist the machine uses, and the defects reported on it (open issues stack repeat reports). */
export async function MachineChecklist({ machine, auth, timeZone, now }: { machine: Machine; auth: AuthContext | null; timeZone: string; now: number }) {
  const { templates, issues } = await machineChecklist(machine.id);
  const canManage = auth !== null && hasRole(auth, "manager");
  const open = issues.filter((i) => !i.resolvedAt);
  const resolved = issues.filter((i) => i.resolvedAt);
  const defaultName = templates.find((t) => t.isDefault)?.name;
  return (
    <section className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Checklist and issues</h2>
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
        <p className="text-sm text-slate-500">No open issues.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {open.map((i) => (
            <li key={i.id} className="flex flex-wrap items-start justify-between gap-3 py-2 text-sm">
              <div>
                <span
                  className={`mr-2 rounded-full px-2 py-0.5 text-xs font-medium ${
                    i.severity === "major"
                      ? "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300"
                      : "bg-amber-100 text-amber-800 dark:bg-amber-900/50 dark:text-amber-300"
                  }`}
                >
                  {i.severity === "major" ? "Major" : "Minor"}
                </span>
                <span className="font-medium">{i.question}</span>
                <div className="text-xs text-slate-500">
                  {i.answerLabel}
                  {i.note && <> · “{i.note}”</>} · first {clockTime(i.firstReportedAt, timeZone, now)}
                  {i.reportCount > 1 && (
                    <>
                      {" "}
                      · reported {i.reportCount} times, last {clockTime(i.lastReportedAt, timeZone, now)}
                    </>
                  )}
                </div>
                {i.photoIds.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {i.photoIds.map((id) => (
                      <a key={id} href={`/photos/${id}`} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- private photo served by /photos/<id> */}
                        <img src={`/photos/${id}`} alt={i.question} loading="lazy" className="h-14 w-14 rounded object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </div>
              {canManage && (
                <form action={resolveIssueAction} className="flex items-center gap-2">
                  <input type="hidden" name="id" value={machine.id} />
                  <input type="hidden" name="issueId" value={i.id} />
                  <input
                    name="note"
                    maxLength={500}
                    placeholder="What was done (optional)"
                    className="w-48 rounded border border-slate-300 bg-transparent px-2 py-1 text-xs dark:border-slate-700"
                  />
                  <button className="rounded border border-slate-300 px-2 py-1 text-xs hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                    Resolved
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      {resolved.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-600 dark:text-slate-400">Recently resolved ({resolved.length})</summary>
          <ul className="mt-1 space-y-0.5 text-xs text-slate-500">
            {resolved.map((i) => (
              <li key={i.id}>
                {i.question} ({i.answerLabel}) · resolved {clockTime(i.resolvedAt!, timeZone, now)}
                {i.resolutionNote && <> · “{i.resolutionNote}”</>}
              </li>
            ))}
          </ul>
        </details>
      )}
      <p className="text-xs text-slate-500">
        Repeat reports of an open issue are added to it rather than listed again, and don&apos;t raise another alert.
      </p>
    </section>
  );
}
