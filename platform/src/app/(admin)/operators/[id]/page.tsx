import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { getOperator } from "@/lib/data";
import { EditOperatorForm } from "../OperatorForms";

export default function EditOperatorPage({ params }: PageProps<"/operators/[id]">) {
  return (
    <div className="max-w-md space-y-6">
      <Link href="/operators" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Operators
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <EditOperator params={params} />
      </Suspense>
    </div>
  );
}

async function EditOperator({ params }: { params: PageProps<"/operators/[id]">["params"] }) {
  const id = Number((await params).id);
  const operator = Number.isInteger(id) ? await getOperator(id) : null;
  if (!operator) notFound();
  return (
    <>
      <h1 className="text-2xl font-semibold">{operator.name}</h1>
      <section className="rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <EditOperatorForm operator={operator} />
      </section>
    </>
  );
}
