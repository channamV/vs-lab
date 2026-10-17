import Link from "next/link";
import { Suspense } from "react";
import { listOperators } from "@/lib/data";
import { AddOperatorForm } from "./OperatorForms";

export default function OperatorsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Operators</h1>
        <p className="text-sm text-slate-500">
          People who check in to machines. They scan the QR sticker on a machine, enter their PIN and complete the pre-start
          checklist.
        </p>
      </div>
      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">Add an operator</h2>
        <AddOperatorForm />
        <p className="text-xs text-slate-500">
          Each operator needs their own PIN. Give it to them in person. It can&apos;t be looked up later, only reset.
        </p>
      </section>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading operators…</p>}>
        <OperatorList />
      </Suspense>
    </div>
  );
}

async function OperatorList() {
  const operators = await listOperators();
  if (operators.length === 0) {
    return <p className="text-sm text-slate-500">No operators yet.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
      <table className="w-full text-left text-sm">
        <thead className="border-b border-slate-200 text-xs uppercase text-slate-500 dark:border-slate-800">
          <tr>
            <th className="px-4 py-2">Name</th>
            <th className="px-4 py-2">Status</th>
            <th className="px-4 py-2">Approved for</th>
            <th className="px-4 py-2" />
          </tr>
        </thead>
        <tbody>
          {operators.map((op) => (
            <tr key={op.id} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
              <td className="px-4 py-2">
                <span className="font-medium">{op.name}</span>
                {op.employeeNumber && <span className="text-slate-500"> #{op.employeeNumber}</span>}
              </td>
              <td className="px-4 py-2">
                {op.active ? (
                  "Active"
                ) : (
                  <span className="text-slate-500">Inactive</span>
                )}
              </td>
              <td className="px-4 py-2">
                {op.machines.length === 0 ? (
                  <span className="text-slate-500">Machines with no approved list</span>
                ) : (
                  op.machines.map((m, i) => (
                    <span key={m.deviceId}>
                      {i > 0 && ", "}
                      <Link href={`/devices/${encodeURIComponent(m.deviceId)}`} className="text-sky-700 hover:underline dark:text-sky-400">
                        {m.name ?? m.deviceId}
                      </Link>
                    </span>
                  ))
                )}
              </td>
              <td className="px-4 py-2 text-right">
                <Link href={`/operators/${op.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
                  Edit
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-slate-100 px-4 py-2 text-xs text-slate-500 dark:border-slate-800">
        Choose which operators are approved for a machine on that machine&apos;s page.
      </p>
    </div>
  );
}
