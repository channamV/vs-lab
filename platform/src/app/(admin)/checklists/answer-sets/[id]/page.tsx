import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { canEditChecklists, getAnswerSet } from "@/lib/data";
import { AnswerSetEditor } from "../../Editors";

/** /checklists/answer-sets/new and /checklists/answer-sets/<id>. */
export default function AnswerSetPage(props: PageProps<"/checklists/answer-sets/[id]">) {
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <Link href="/checklists" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Checklists
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <AnswerSet {...props} />
      </Suspense>
    </div>
  );
}

async function AnswerSet({ params }: PageProps<"/checklists/answer-sets/[id]">) {
  await connection();
  if (!(await canEditChecklists())) notFound();
  const raw = (await params).id;
  if (raw === "new") {
    return (
      <>
        <h1 className="text-3xl font-semibold">New answer set</h1>
        <AnswerSetEditor
          answerSet={{
            id: null,
            name: "",
            options: [
              { key: "ok", label: "OK", severity: "pass", color: "#059669" },
              { key: "minor_defect", label: "Minor defect", severity: "minor", color: "#d97706" },
              { key: "major_defect", label: "Major defect", severity: "major", color: "#dc2626" },
              { key: "na", label: "Not applicable", severity: "na", color: "#64748b" },
            ],
          }}
        />
      </>
    );
  }
  if (!/^\d+$/.test(raw)) notFound();
  const set = await getAnswerSet(Number(raw));
  if (!set) notFound();
  return (
    <>
      <h1 className="text-3xl font-semibold">Edit answer set</h1>
      <AnswerSetEditor answerSet={{ id: set.id, name: set.name, options: set.options }} />
    </>
  );
}
