import Link from "next/link";
import { Suspense } from "react";
import { canEditChecklists, checklistSettings } from "@/lib/data";
import { requireRoleForPage } from "@/lib/session";
import { connection } from "next/server";
import { CHECKLIST_LIBRARY } from "@/lib/checklist-library";
import { CHECKLIST_FREQUENCIES, type ChecklistFrequency } from "@/lib/checklist-frequency";
import { addLibraryTemplateAction, deleteAnswerSetAction, deleteTemplateAction, setDefaultTemplateAction } from "./actions";

const card = "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";
const link = "text-sm text-sky-700 hover:underline dark:text-sky-400";

/** The company's pre-start checklists and the answer sets they use. */
export default function ChecklistsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Checklists</h1>
        <p className="text-sm text-slate-500">
          The pre-start checklists operators complete when they check in. Each machine uses the default checklist unless you
          choose another on the machine&apos;s page.{" "}
          <Link href="/checklists/results" className={link}>
            See completed checklists →
          </Link>
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Checklists />
      </Suspense>
    </div>
  );
}

async function Checklists() {
  await connection();
  await requireRoleForPage("manager");
  const [{ templates, answerSets }, canEdit] = await Promise.all([checklistSettings(), canEditChecklists()]);
  return (
    <>
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="font-semibold">Checklists</h2>
          {canEdit && (
            <Link href="/checklists/templates/new" className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
              + New checklist
            </Link>
          )}
        </div>
        {templates.map((t) => (
          <article key={t.id} className={`${card} flex flex-wrap items-center justify-between gap-3`}>
            <div>
              <h3 className="font-semibold">
                {t.name}
                {t.isDefault && <span className="ml-2 rounded-full bg-sky-100 px-2 py-0.5 text-xs font-medium text-sky-800 dark:bg-sky-900/50 dark:text-sky-300">Default</span>}
              </h3>
              <p className="text-sm text-slate-500">
                {t.sections.length} section{t.sections.length === 1 ? "" : "s"} · {t.questionCount} questions · {t.answerSetName} answers ·{" "}
                {CHECKLIST_FREQUENCIES[t.frequency as ChecklistFrequency]?.label ?? CHECKLIST_FREQUENCIES.every_checkin.label} ·{" "}
                {t.machines} machine{t.machines === 1 ? "" : "s"}
              </p>
            </div>
            {canEdit && (
              <div className="flex items-center gap-4">
                <Link href={`/checklists/templates/${t.id}`} className={link}>
                  Edit
                </Link>
                <Link href={`/checklists/templates/new?from=${t.id}`} className={link}>
                  Copy
                </Link>
                {!t.isDefault && (
                  <>
                    <form action={setDefaultTemplateAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className={link}>Make default</button>
                    </form>
                    <form action={deleteTemplateAction}>
                      <input type="hidden" name="id" value={t.id} />
                      <button className="text-sm text-red-700 hover:underline dark:text-red-400">Delete</button>
                    </form>
                  </>
                )}
              </div>
            )}
          </article>
        ))}
      </section>

      {canEdit && (
        <section className="space-y-3">
          <div>
            <h2 className="font-semibold">Ready-made checklists</h2>
            <p className="text-xs text-slate-500">
              Regulation-based checklists you can add, then edit like your own. Check them against the current regulation for your
              jurisdiction before relying on them.
            </p>
          </div>
          {CHECKLIST_LIBRARY.map((item) => {
            const added = templates.some((t) => t.name === item.name);
            return (
              <article key={item.key} className={`${card} flex flex-wrap items-center justify-between gap-3`}>
                <div className="max-w-2xl">
                  <h3 className="font-semibold">{item.name}</h3>
                  <p className="text-sm text-slate-500">{item.summary}</p>
                </div>
                {added ? (
                  <span className="text-sm text-slate-500">Added</span>
                ) : (
                  <form action={addLibraryTemplateAction}>
                    <input type="hidden" name="key" value={item.key} />
                    <button className="rounded-lg border border-sky-700 px-3 py-1.5 text-sm text-sky-700 hover:bg-sky-50 dark:border-sky-400 dark:text-sky-400 dark:hover:bg-slate-800">
                      Add
                    </button>
                  </form>
                )}
              </article>
            );
          })}
        </section>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="font-semibold">Answer sets</h2>
            <p className="text-xs text-slate-500">The answers operators choose from. Each checklist uses one set.</p>
          </div>
          {canEdit && (
            <Link href="/checklists/answer-sets/new" className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
              + New answer set
            </Link>
          )}
        </div>
        {answerSets.map((a) => (
          <article key={a.id} className={`${card} flex flex-wrap items-center justify-between gap-3`}>
            <div className="space-y-1.5">
              <h3 className="font-semibold">{a.name}</h3>
              <div className="flex flex-wrap gap-1.5">
                {a.options.map((o) => (
                  <span key={o.key} className="rounded-full px-2 py-0.5 text-xs text-white" style={{ backgroundColor: o.color }}>
                    {o.label}
                  </span>
                ))}
              </div>
            </div>
            {canEdit && (
              <div className="flex items-center gap-4">
                <Link href={`/checklists/answer-sets/${a.id}`} className={link}>
                  Edit
                </Link>
                {a.usedBy === 0 && (
                  <form action={deleteAnswerSetAction}>
                    <input type="hidden" name="id" value={a.id} />
                    <button className="text-sm text-red-700 hover:underline dark:text-red-400">Delete</button>
                  </form>
                )}
              </div>
            )}
          </article>
        ))}
      </section>
      {!canEdit && <p className="text-xs text-slate-500">Only managers with access to the whole company can change checklists.</p>}
    </>
  );
}
