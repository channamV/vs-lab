import Link from "next/link";
import { locationLabel } from "@/lib/checkin-flags";
import { RESULT_LABELS, resultMachine, type ResultKind } from "@/lib/checklist-results";
import type { ChecklistAnswer } from "@/lib/db/schema";

/** One checklist's answers by section, with defects highlighted, notes and photos. Shared by the detail page and the printable report. */

const BADGE: Record<ResultKind, string> = {
  ok: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/50 dark:text-emerald-300",
  defects: "bg-amber-100 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200",
  locked_out: "bg-red-100 text-red-800 dark:bg-red-900/50 dark:text-red-300",
  covered: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
};
const ICON: Record<ResultKind, string> = { ok: "✓", defects: "⚠", locked_out: "🔒", covered: "↺" };

export function ResultBadge({ kind, defects }: { kind: ResultKind; defects?: number }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap ${BADGE[kind]}`}>
      <span aria-hidden>{ICON[kind]}</span>
      {kind === "defects" && defects ? `${defects} defect${defects === 1 ? "" : "s"}` : RESULT_LABELS[kind]}
    </span>
  );
}

const ANSWER: Record<string, string> = {
  pass: "text-emerald-700 dark:text-emerald-400",
  minor: "text-amber-700 dark:text-amber-400",
  major: "text-red-700 dark:text-red-400",
  na: "text-slate-500",
};

export type ResultForView = {
  id: number;
  startedAt: Date;
  machineId: number;
  machineName: string;
  unitNumber: string | null;
  operatorName: string;
  templateName: string | null;
  result: ResultKind;
  answers: ChecklistAnswer[];
  notes: string | null;
  confirmationText: string | null;
  authorized: boolean;
  locationCheck: string | null;
  distanceM: number | null;
  photos: { id: number; questionId: string }[];
  covering?: { id: number; startedAt: Date; operatorName: string } | null;
};

export function ResultView({ r, timeZone, linkMachine = true }: { r: ResultForView; timeZone: string; linkMachine?: boolean }) {
  const when = new Intl.DateTimeFormat("en-CA", { timeZone, dateStyle: "medium", timeStyle: "short" });
  const sections: { title: string; answers: ChecklistAnswer[] }[] = [];
  for (const a of r.answers) {
    const title = a.section ?? "Checklist";
    const last = sections.at(-1);
    if (last && last.title === title) last.answers.push(a);
    else sections.push({ title, answers: [a] });
  }
  const defects = r.answers.filter((a) => !a.ok).length;
  const at = locationLabel(r);
  return (
    <article className="space-y-4 break-inside-avoid-page">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-xl font-semibold">
            {linkMachine ? (
              <Link href={`/machines/${r.machineId}`} className="hover:underline print:no-underline">
                {resultMachine(r)}
              </Link>
            ) : (
              resultMachine(r)
            )}
          </h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            {when.format(r.startedAt)} · {r.operatorName} · {r.templateName ?? "Checklist"}
          </p>
        </div>
        <ResultBadge kind={r.result} defects={defects} />
      </div>

      <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-slate-500">At the machine</dt>
          <dd className={at.warn ? "text-amber-700 dark:text-amber-400" : ""}>{at.text}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Approved operator</dt>
          <dd className={r.authorized ? "" : "text-amber-700 dark:text-amber-400"}>{r.authorized ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt className="text-slate-500">Check-in</dt>
          <dd>#{r.id}</dd>
        </div>
      </dl>

      {r.result === "covered" ? (
        <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          No checklist on this check-in: today&apos;s checklist on this machine was already done
          {r.covering && (
            <>
              {" "}
              by {r.covering.operatorName} at {when.format(r.covering.startedAt)} (
              <Link href={`/checklists/results/${r.covering.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                view it
              </Link>
              )
            </>
          )}
          .
        </p>
      ) : (
        sections.map((s) => (
          <section key={s.title} className="rounded-lg border border-slate-200 dark:border-slate-800">
            <h3 className="border-b border-slate-200 bg-slate-50 px-3 py-1.5 text-sm font-semibold tracking-wide text-slate-600 uppercase dark:border-slate-800 dark:bg-slate-900 dark:text-slate-400">
              {s.title}
            </h3>
            <ul className="divide-y divide-slate-100 dark:divide-slate-800">
              {s.answers.map((a) => {
                const photos = r.photos.filter((p) => p.questionId === a.id);
                return (
                  <li key={a.id} className={`px-3 py-2 text-sm break-inside-avoid ${a.ok ? "" : "bg-amber-50/60 dark:bg-amber-950/30"}`}>
                    <div className="flex flex-wrap justify-between gap-x-4">
                      <span>
                        {!a.ok && <span aria-hidden>⚠️ </span>}
                        {a.question}
                      </span>
                      <span className={`font-medium ${a.textOnly ? "" : ANSWER[a.severity ?? (a.ok ? "pass" : "major")]}`}>
                        {a.answer ?? (a.ok ? "OK" : "Not OK")}
                      </span>
                    </div>
                    {a.note && <p className="mt-1 text-slate-600 dark:text-slate-400">Note: {a.note}</p>}
                    {photos.length > 0 && (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {photos.map((p) => (
                          <a key={p.id} href={`/photos/${p.id}`} target="_blank" rel="noreferrer">
                            {/* eslint-disable-next-line @next/next/no-img-element -- private photo served by /photos/<id>, not optimisable */}
                            <img src={`/photos/${p.id}`} alt={`Photo: ${a.question}`} loading="lazy" className="h-28 w-28 rounded border border-slate-200 object-cover print:h-40 print:w-40 dark:border-slate-700" />
                          </a>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        ))
      )}

      {r.notes && (
        <p className="text-sm">
          <span className="text-slate-500">Operator&apos;s notes:</span> {r.notes}
        </p>
      )}
      {r.confirmationText && (
        <p className="rounded-lg border border-slate-200 p-3 text-sm dark:border-slate-800">
          <span className="text-slate-500">Confirmed by {r.operatorName}:</span> &ldquo;{r.confirmationText}&rdquo;
        </p>
      )}
      {r.result === "locked_out" && (
        <p className="text-sm font-medium text-red-700 dark:text-red-400">The operator locked the machine out for repair.</p>
      )}
    </article>
  );
}
