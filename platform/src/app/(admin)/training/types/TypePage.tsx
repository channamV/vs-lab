import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getCertificationType, trainingData } from "@/lib/data";
import { requireRoleForPage } from "@/lib/session";
import { CertificationTypeForm } from "../TrainingForms";

/** Add (id null) or edit a certification type: whole-company managers and owners. */
export async function TypePage({ id }: { id: number | null }) {
  await connection(); // request-time page (the sign-in check reads the clock)
  const auth = await requireRoleForPage("manager");
  const [type, data] = await Promise.all([id === null ? null : getCertificationType(id), trainingData()]);
  if (id !== null && !type) notFound();
  return (
    <div className="max-w-2xl space-y-5">
      <Link href="/training#certifications" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Training
      </Link>
      <h1 className="text-2xl font-semibold">{type ? type.name : "Add certification"}</h1>
      {auth.divisionIds !== null ? (
        <p className="text-sm text-slate-500">Only managers with access to the whole company can change certifications.</p>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <CertificationTypeForm type={type} categories={data.categories} machines={data.machines} />
        </section>
      )}
    </div>
  );
}
