import Link from "next/link";
import { notFound } from "next/navigation";
import { schedulesData } from "@/lib/data";
import { ScheduleForm } from "./ScheduleForm";

/** Shared by New, Edit and Duplicate. */
export async function ScheduleFormPage({ id, duplicateId }: { id?: number; duplicateId?: number }) {
  const data = await schedulesData();
  const source = data.schedules.find((s) => s.id === (id ?? duplicateId));
  if ((id || duplicateId) && !source) notFound();
  if (id && source && !source.canManage) notFound();
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{id ? "Edit schedule" : "New schedule"}</h1>
          <p className="text-sm text-slate-500">Automate machine mode changes and temporary operator access.</p>
        </div>
        <Link href="/schedules" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← Schedules
        </Link>
      </div>
      <ScheduleForm
        id={id}
        duplicate={!!duplicateId}
        initial={source ?? null}
        data={{
          machines: data.machines.map((m) => ({ id: m.id, label: m.name, mode: m.mode })),
          machineNames: data.machineNames.map((m) => ({ id: m.id, label: m.name })),
          operators: data.operators.map((o) => ({ id: o.id, label: o.name })),
          others: data.schedules,
          actions: data.actions,
          wholeOrganization: data.wholeOrganization,
          fleetTimezone: data.fleetTimezone,
          conflictRule: data.conflictRule,
        }}
      />
    </div>
  );
}
