import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { requireRoleForPage } from "@/lib/session";
import { listDivisions, listMachineCategories, scanEnabled } from "@/lib/data";
import { AddMachineForm } from "../MachineForms";

/** Managers and owners add a piece of equipment. Veristart then pairs a tracking device with it. */
export default function NewMachinePage() {
  return (
    <div className="max-w-2xl space-y-6">
      <Link href="/" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Fleet
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Add machine</h1>
        <p className="text-sm text-slate-500">
          Only a name is required. The unit / fleet number is how the machine is shown everywhere, so add it if you use one.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Form />
      </Suspense>
    </div>
  );
}

async function Form() {
  await connection(); // request-time page (the sign-in check reads the clock)
  const auth = await requireRoleForPage("manager");
  const [divisions, categories, scan] = await Promise.all([listDivisions(), listMachineCategories(), scanEnabled()]);
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
      <AddMachineForm choice={{ divisions, allowNone: auth.divisionIds === null, categories, scan, controlAllowed: auth.isPlatformAdmin }} />
    </section>
  );
}
