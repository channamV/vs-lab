import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { canManageOperatorData, getOperator, operatorTraining } from "@/lib/data";
import { STATUS_LABELS, STATUS_STYLE } from "@/lib/training-status";
import { deleteTrainingRecordAction } from "../../training/actions";
import { TrainingRecordForm } from "../../training/TrainingForms";
import { EditOperatorForm, EraseOperatorForm } from "../OperatorForms";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

export default function EditOperatorPage({ params }: PageProps<"/operators/[id]">) {
  return (
    <div className="max-w-2xl space-y-6">
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
      {!operator.erasedAt && <Training operatorId={operator.id} />}
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
                  For an operator who asks to be forgotten. Removes their name, contact details, employee #, PIN, machine approvals,
                  training records, phone locations and checklist photos, and replaces their name in alerts and defect notes. Their check-ins and
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

/** Training records: status today, the certificate, and (managers) add / edit / delete. */
async function Training({ operatorId }: { operatorId: number }) {
  const data = await operatorTraining(operatorId);
  return (
    <section id="training" className={card}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold">Training &amp; certifications</h2>
        <Link href="/training" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          All training →
        </Link>
      </div>
      {data.records.length === 0 ? (
        <p className="text-sm text-slate-500">No training records yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {data.records.map((r) => (
            <li key={r.id} className="space-y-1 py-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className={r.replaced ? "text-slate-500" : "font-medium"}>{r.typeName}</span>
                {r.replaced ? (
                  <span className="text-xs text-slate-500">Replaced by a newer record</span>
                ) : (
                  <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABELS[r.status]}</span>
                )}
              </div>
              <p className="text-xs text-slate-500">
                Issued {r.issuedOn} · {r.expiresOn ? `expires ${r.expiresOn}` : "no expiry"}
                {r.provider && ` · ${r.provider}`}
                {r.certificateNumber && ` · #${r.certificateNumber}`} · entered by {r.enteredBy}
              </p>
              {r.notes && <p className="text-xs">{r.notes}</p>}
              <div className="flex flex-wrap gap-3 text-xs">
                {r.documentKey && (
                  <a href={`/training/documents/${r.id}`} target="_blank" className="text-sky-700 hover:underline dark:text-sky-400">
                    View certificate
                  </a>
                )}
                {data.canEdit && (
                  <details className="w-full">
                    <summary className="cursor-pointer text-sky-700 dark:text-sky-400">Edit or delete</summary>
                    <div className="mt-2 space-y-3 rounded border border-slate-200 p-3 dark:border-slate-700">
                      <TrainingRecordForm operatorId={operatorId} record={r} types={data.types} />
                      <form action={deleteTrainingRecordAction}>
                        <input type="hidden" name="id" value={r.id} />
                        <button className="text-red-700 hover:underline dark:text-red-400">Delete this record</button>
                      </form>
                    </div>
                  </details>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.canEdit && (
        <details className="text-sm" open={data.records.length === 0}>
          <summary className="cursor-pointer font-medium text-sky-700 dark:text-sky-400">Add training record</summary>
          <div className="mt-2">
            <TrainingRecordForm operatorId={operatorId} types={data.types} />
          </div>
        </details>
      )}
    </section>
  );
}
