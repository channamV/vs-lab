import Link from "next/link";
import { Suspense } from "react";
import { maintenanceMachineChoices } from "@/lib/data";
import { requireRoleForPage } from "@/lib/session";
import { NewIssueForm } from "./NewIssueForm";

/** A maintenance item staff add themselves (a problem found during work, a mechanic's note). */
export default function NewIssuePage({ searchParams }: PageProps<"/maintenance/issues/new">) {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/maintenance" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Maintenance
      </Link>
      <h1 className="text-2xl font-semibold">New maintenance item</h1>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Form searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Form({ searchParams }: { searchParams: PageProps<"/maintenance/issues/new">["searchParams"] }) {
  await requireRoleForPage("manager");
  const machine = (await searchParams).machine;
  const machines = await maintenanceMachineChoices();
  return <NewIssueForm machines={machines} machineId={typeof machine === "string" ? machine : ""} />;
}
