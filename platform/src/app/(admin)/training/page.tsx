import Link from "next/link";
import { Suspense } from "react";
import { trainingData } from "@/lib/data";
import { STATUS_LABELS, STATUS_STYLE } from "@/lib/training-status";
import { deleteCategoryAction } from "./actions";
import { AddCategoryForm } from "./TrainingForms";

const card = "rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";
const FILTERS = ["all", "expired", "grace", "expiring", "valid"] as const;
type Filter = (typeof FILTERS)[number];

/** Operator training and certifications (docs/training.md). */
export default function TrainingPage({ searchParams }: PageProps<"/training">) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Training</h1>
        <p className="text-sm text-slate-500">
          Operators&apos; certifications, what&apos;s expiring, and which machines each certification covers. Add records on each
          operator&apos;s page.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading training…</p>}>
        <Training searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Training({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [data, sp] = await Promise.all([trainingData(), searchParams]);
  const filter: Filter = FILTERS.includes(sp.status as Filter) ? (sp.status as Filter) : "all";
  const count = (f: Filter) => (f === "all" ? data.rows.length : data.rows.filter((r) => r.status === f).length);
  const rows = data.rows.filter((r) => filter === "all" || r.status === filter);
  const catName = new Map(data.categories.map((c) => [c.id, c.name]));
  const machineName = new Map(data.machines.map((m) => [m.id, m.name]));
  const active = data.types.filter((t) => t.active);
  const unused = data.types.filter((t) => !t.active);

  return (
    <>
      <section className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Operators&apos; certifications</h2>
          <a href={`/training/export?status=${filter}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
            Download CSV
          </a>
        </div>
        <div className="flex flex-wrap gap-2 text-sm">
          {FILTERS.map((f) => (
            <Link
              key={f}
              href={f === "all" ? "/training" : `/training?status=${f}`}
              className={`rounded-full border px-3 py-1 ${f === filter ? "border-sky-700 bg-sky-700 text-white" : "border-slate-300 dark:border-slate-700"}`}
            >
              {f === "all" ? "All" : STATUS_LABELS[f]} ({count(f)})
            </Link>
          ))}
        </div>
        {rows.length === 0 ? (
          <p className="text-sm text-slate-500">
            {data.rows.length === 0 ? "No training records yet. Open an operator from the Operators page to add one." : "Nothing here."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-slate-500">
                <tr>
                  <th className="py-1 pr-3 font-normal">Operator</th>
                  <th className="py-1 pr-3 font-normal">Certification</th>
                  <th className="py-1 pr-3 font-normal">Expires</th>
                  <th className="py-1 font-normal">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.record.id} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1.5 pr-3">
                      <Link href={`/operators/${r.operator.id}#training`} className="text-sky-700 hover:underline dark:text-sky-400">
                        {r.operator.name}
                      </Link>
                      {!r.operator.active && <span className="ml-1 text-xs text-slate-500">(inactive)</span>}
                    </td>
                    <td className="py-1.5 pr-3">{r.type.name}</td>
                    <td className="py-1.5 pr-3 whitespace-nowrap">
                      {r.record.expiresOn ?? "No expiry"}
                      {r.daysLeft !== null && r.daysLeft >= 0 && <span className="text-slate-500"> · {r.daysLeft} d</span>}
                    </td>
                    <td className="py-1.5">
                      <span className={`rounded px-2 py-0.5 text-xs ${STATUS_STYLE[r.status]}`}>{STATUS_LABELS[r.status]}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section id="certifications" className={`${card} space-y-3`}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Certifications</h2>
          {data.canEditTypes && (
            <Link href="/training/types/new" className="rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
              Add certification
            </Link>
          )}
        </div>
        <p className="text-sm text-slate-500">
          <strong>Auto-grant</strong>: a valid record lets the operator check in on the machines it covers. <strong>Required</strong>: without
          a valid record, they can&apos;t. Access is worked out at each check-in, so renewing a record restores it straight away.
        </p>
        {active.length === 0 && <p className="text-sm text-slate-500">No certifications in use yet. Turn on one of the starter ones below.</p>}
        <TypeList types={active} catName={catName} machineName={machineName} canEdit={data.canEditTypes} />
        {unused.length > 0 && (
          <details className="text-sm">
            <summary className="cursor-pointer text-sky-700 dark:text-sky-400">Not in use ({unused.length}), including the starter list</summary>
            <div className="mt-2">
              <TypeList types={unused} catName={catName} machineName={machineName} canEdit={data.canEditTypes} />
            </div>
          </details>
        )}
      </section>

      <section className={`${card} space-y-3`}>
        <h2 className="font-semibold">Machine categories</h2>
        <p className="text-sm text-slate-500">Set each machine&apos;s category on its Edit page. Certifications cover machines by category.</p>
        <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
          {data.categories.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 py-1.5">
              <span>
                {c.name} <span className="text-slate-500">· {c.machineCount} machine{c.machineCount === 1 ? "" : "s"}</span>
              </span>
              {data.canEditTypes && (
                <form action={deleteCategoryAction}>
                  <input type="hidden" name="id" value={c.id} />
                  <button className="text-xs text-red-700 hover:underline dark:text-red-400">Delete</button>
                </form>
              )}
            </li>
          ))}
        </ul>
        {data.canEditTypes && <AddCategoryForm />}
      </section>
    </>
  );
}

type TypeRow = Awaited<ReturnType<typeof trainingData>>["types"][number];

function TypeList({ types, catName, machineName, canEdit }: { types: TypeRow[]; catName: Map<number, string>; machineName: Map<number, string>; canEdit: boolean }) {
  return (
    <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
      {types.map((t) => {
        const covers = [...t.categoryIds.map((id) => catName.get(id)), ...t.machineIds.map((id) => machineName.get(id))].filter(Boolean);
        return (
          <li key={t.id} className="flex flex-wrap items-start justify-between gap-2 py-2">
            <div>
              <p className="font-medium">{t.name}</p>
              <p className="text-xs text-slate-500">
                {t.validityMonths ? `Valid ${t.validityMonths} months` : "No expiry"}
                {t.graceDays ? ` · ${t.graceDays} days' grace` : ""} · Covers: {covers.length ? covers.join(", ") : "no machines (record only)"}
              </p>
              {t.active && (
                <p className="text-xs">
                  Auto-grant: <strong>{t.autoGrant ? "Yes" : "No"}</strong> · Required: <strong>{t.required ? "Yes" : "No"}</strong>
                </p>
              )}
            </div>
            {canEdit && (
              <Link href={`/training/types/${t.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                {t.active ? "Edit" : "Set up"}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
