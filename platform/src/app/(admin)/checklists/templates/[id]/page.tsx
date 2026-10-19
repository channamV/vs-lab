import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { canEditChecklists, checklistSettings, getChecklistTemplate } from "@/lib/data";
import { DEFAULT_CONFIRMATION } from "@/lib/checklists";
import { TemplateEditor } from "../../Editors";

/** /checklists/templates/new (optionally ?from=<id> to copy one) and /checklists/templates/<id>. */
export default function TemplatePage(props: PageProps<"/checklists/templates/[id]">) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/checklists" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Checklists
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Template {...props} />
      </Suspense>
    </div>
  );
}

async function Template({ params, searchParams }: PageProps<"/checklists/templates/[id]">) {
  await connection();
  if (!(await canEditChecklists())) notFound();
  const raw = (await params).id;
  const isNew = raw === "new";
  const fromRaw = (await searchParams).from;
  const sourceId = isNew ? (typeof fromRaw === "string" && /^\d+$/.test(fromRaw) ? Number(fromRaw) : null) : /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (Number.isNaN(sourceId)) notFound();
  const [{ answerSets }, source] = await Promise.all([checklistSettings(), sourceId ? getChecklistTemplate(sourceId) : null]);
  if (sourceId && !source) notFound();
  const template = source
    ? {
        id: isNew ? null : source.id,
        name: isNew ? `${source.name} (copy)` : source.name,
        answerSetId: source.answerSetId,
        confirmationText: source.confirmationText,
        // A copy gets fresh ids, so its issues don't stack with the original's questions by accident.
        sections: isNew ? source.sections.map((s) => ({ title: s.title, questions: s.questions.map((q) => ({ text: q.text, noteRequired: q.noteRequired })) })) : source.sections,
      }
    : {
        id: null,
        name: "",
        answerSetId: answerSets[0].id,
        confirmationText: DEFAULT_CONFIRMATION,
        sections: [{ title: "", questions: [{ text: "", noteRequired: false }] }],
      };
  return (
    <>
      <h1 className="text-3xl font-semibold">{template.id ? "Edit checklist" : "New checklist"}</h1>
      {template.id && (
        <p className="text-sm text-slate-500">Changes apply to the next check-in. Past check-ins keep the questions as they were asked.</p>
      )}
      <TemplateEditor template={template as never} answerSets={answerSets} />
    </>
  );
}
