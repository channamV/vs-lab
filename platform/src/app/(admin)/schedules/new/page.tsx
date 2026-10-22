import { Suspense } from "react";
import { ScheduleFormPage } from "../FormPage";

export default function NewSchedulePage({ searchParams }: PageProps<"/schedules/new">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <New searchParams={searchParams} />
    </Suspense>
  );
}

async function New({ searchParams }: Pick<PageProps<"/schedules/new">, "searchParams">) {
  const duplicate = Number((await searchParams).duplicate);
  return <ScheduleFormPage duplicateId={Number.isSafeInteger(duplicate) && duplicate > 0 ? duplicate : undefined} />;
}
