import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ScheduleFormPage } from "../FormPage";

export default function EditSchedulePage({ params }: PageProps<"/schedules/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <Edit params={params} />
    </Suspense>
  );
}

async function Edit({ params }: Pick<PageProps<"/schedules/[id]">, "params">) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  return <ScheduleFormPage id={id} />;
}
