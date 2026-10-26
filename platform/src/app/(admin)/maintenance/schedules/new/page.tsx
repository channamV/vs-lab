import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { maintenanceMachineChoices } from "@/lib/data";
import { requireRoleForPage } from "@/lib/session";
import { ScheduleForm } from "../ScheduleForms";

export default function NewSchedulePage({ searchParams }: PageProps<"/maintenance/schedules/new">) {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/maintenance/schedules" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Service schedules
      </Link>
      <h1 className="text-2xl font-semibold">New service schedule</h1>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/maintenance/schedules/new">["searchParams"] }) {
  await connection(); // request-time page: read the session (and the time) now, not while prerendering
  await requireRoleForPage("manager");
  const machine = Number((await searchParams).machine) || null;
  const machines = await maintenanceMachineChoices();
  return (
    <ScheduleForm
      machines={machines}
      schedule={{ id: null, machineId: machine, description: "", everyHours: null, everyKm: null, everyDays: null, active: true }}
    />
  );
}
