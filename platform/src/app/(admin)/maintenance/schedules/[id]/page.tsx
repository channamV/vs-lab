import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { maintenanceMachineChoices, maintenanceScheduleById } from "@/lib/data";
import { requireRoleForPage } from "@/lib/session";
import { deleteScheduleAction } from "../../actions";
import { ScheduleForm } from "../ScheduleForms";

export default function EditSchedulePage({ params }: PageProps<"/maintenance/schedules/[id]">) {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/maintenance/schedules" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Service schedules
      </Link>
      <h1 className="text-2xl font-semibold">Service schedule</h1>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Form params={params} />
      </Suspense>
    </div>
  );
}

async function Form({ params }: { params: PageProps<"/maintenance/schedules/[id]">["params"] }) {
  await requireRoleForPage("manager");
  const id = Number((await params).id);
  const schedule = Number.isSafeInteger(id) && id > 0 ? await maintenanceScheduleById(id) : null;
  if (!schedule) notFound();
  const machines = await maintenanceMachineChoices();
  return (
    <>
      <ScheduleForm machines={machines} schedule={schedule} />
      <details className="text-sm">
        <summary className="cursor-pointer text-slate-500">Delete this schedule</summary>
        <form action={deleteScheduleAction} className="mt-2 space-y-2">
          <input type="hidden" name="scheduleId" value={schedule.id} />
          <p className="text-slate-600 dark:text-slate-400">Its past service items stay in the history. To stop it for a while, untick Active instead.</p>
          <button className="rounded-lg border border-red-300 px-3 py-2 font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
            Delete schedule
          </button>
        </form>
      </details>
    </>
  );
}
