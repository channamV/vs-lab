import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { checklistResult } from "@/lib/data";
import { PrintButton } from "../PrintButton";
import { ResultView } from "../ResultView";

/** One pre-start checklist: answers by section, defects, notes, photos and the operator's confirmation. */
export default function ChecklistResultPage({ params }: PageProps<"/checklists/results/[id]">) {
  return (
    <div className="max-w-3xl space-y-5">
      <div className="flex items-center justify-between gap-2 print:hidden">
        <Link href="/checklists/results" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← Checklist results
        </Link>
        <PrintButton />
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Result params={params} />
      </Suspense>
    </div>
  );
}

async function Result({ params }: { params: PageProps<"/checklists/results/[id]">["params"] }) {
  const id = Number((await params).id);
  const data = Number.isInteger(id) && id > 0 ? await checklistResult(id) : null;
  if (!data) notFound();
  return <ResultView r={data.result} timeZone={data.timeZone} />;
}
