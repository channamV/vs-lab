import Link from "next/link";
import { Suspense } from "react";
import { breachRegister } from "@/lib/data";
import { VERISTART_PRIVACY } from "@/lib/privacy-limits";
import { BreachForm } from "./BreachForm";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";
const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : "");

/** Veristart staff only: the privacy breach register (PIPEDA). */
export default function BreachesPage() {
  return (
    <div className="max-w-4xl space-y-6">
      <Link href="/platform" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Platform
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Privacy breach register</h1>
        <p className="text-sm text-slate-500">
          Record <strong>every</strong> breach of security involving personal information, even small ones (an email to the wrong
          person, a lost phone with the portal signed in). PIPEDA requires the record to be kept for at least 24 months. If there&apos;s a
          real risk of significant harm, report it to the Privacy Commissioner of Canada and notify the people affected as soon as
          feasible. Tell Veristart&apos;s Privacy Officer ({VERISTART_PRIVACY.officerEmail}) straight away. See docs/privacy-canada.md.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Register />
      </Suspense>
      <section className={card}>
        <h2 className="font-semibold">Record a breach</h2>
        <BreachForm />
      </section>
    </div>
  );
}

async function Register() {
  const records = await breachRegister();
  return (
    <section className={card}>
      <h2 className="font-semibold">Records ({records.length})</h2>
      {records.length === 0 ? (
        <p className="text-sm text-slate-500">None recorded.</p>
      ) : (
        <ul className="divide-y divide-slate-100 dark:divide-slate-800">
          {records.map((b) => (
            <li key={b.id} className="py-3">
              <details>
                <summary className="cursor-pointer text-sm">
                  <span className="font-medium">{day(b.discoveredAt)}</span> · {b.description.slice(0, 120)}
                  {b.closedAt ? (
                    <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-600 dark:bg-slate-800">closed</span>
                  ) : (
                    <span className="ml-2 text-xs text-amber-700 dark:text-amber-400">To do: {b.todo.join(" · ")}</span>
                  )}
                </summary>
                <div className="mt-3">
                  <p className="mb-2 text-xs text-slate-500">Recorded by {b.recordedBy}</p>
                  <BreachForm
                    id={b.id}
                    initial={{
                      occurredAt: day(b.occurredAt),
                      discoveredAt: day(b.discoveredAt),
                      description: b.description,
                      dataInvolved: b.dataInvolved ?? "",
                      organizationsAffected: b.organizationsAffected ?? "",
                      peopleAffected: b.peopleAffected?.toString() ?? "",
                      realRisk: b.realRiskOfSignificantHarm === null ? "" : b.realRiskOfSignificantHarm ? "yes" : "no",
                      riskReasoning: b.riskReasoning ?? "",
                      reportedToCommissionerAt: day(b.reportedToCommissionerAt),
                      individualsNotifiedAt: day(b.individualsNotifiedAt),
                      customersNotifiedAt: day(b.customersNotifiedAt),
                      actionsTaken: b.actionsTaken ?? "",
                      closed: b.closedAt !== null,
                    }}
                  />
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
