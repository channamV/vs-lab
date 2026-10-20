import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { canManageOperatorData, getOperator } from "@/lib/data";
import { EditOperatorForm, EraseOperatorForm } from "../OperatorForms";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

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
  const canManageData = await canManageOperatorData();
  return (
    <>
      <h1 className="text-2xl font-semibold">{operator.name}</h1>
      {operator.erasedAt ? (
        <p className={`${card} text-sm text-slate-600 dark:text-slate-400`}>
          This operator&apos;s personal data was erased on {operator.erasedAt.toLocaleDateString("en-CA")}. Their check-ins stay on
          the machines&apos; records under this name. If they come back, add them as a new operator.
        </p>
      ) : (
        <section className={card}>
          <EditOperatorForm operator={operator} />
        </section>
      )}
      {canManageData && (
        <section className={card}>
          <h2 className="font-semibold">Operator&apos;s data (privacy requests)</h2>
          <p className="text-sm text-slate-600 dark:text-slate-400">
            If the operator asks what&apos;s stored about them, download it and send it to them.
          </p>
          <a
            href={`/operators/${operator.id}/export`}
            className="inline-block rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"
          >
            Download their data (JSON)
          </a>
          {!operator.erasedAt && (
            <details className="pt-2">
              <summary className="cursor-pointer text-sm text-red-700 dark:text-red-400">Erase their data…</summary>
              <div className="mt-2 space-y-2 text-sm text-slate-600 dark:text-slate-400">
                <p>
                  For an operator who asks to be forgotten. Removes their name, employee #, PIN, machine approvals, phone
                  locations and checklist photos, and replaces their name in alerts and defect notes. Their check-ins and
                  checklist answers stay on the machines&apos; records as &ldquo;Former operator #{operator.id}&rdquo;.
                  This can&apos;t be undone.
                </p>
                <EraseOperatorForm operatorId={operator.id} />
              </div>
            </details>
          )}
        </section>
      )}
    </>
  );
}
