import { Suspense } from "react";
import { privacySettings, requestTime } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { PrivacyForm } from "./PrivacyForm";
import { ReportPlanForm } from "./ReportPlanForm";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

const ACTIONS: Record<string, string> = {
  "staff-view": "Veristart staff opened your organization",
  "operator-export": "Operator data downloaded",
  "operator-erase": "Operator data erased",
};

/** Owners: privacy settings (GDPR) and the log of staff access and operator data requests. */
export default function SettingsPage() {
  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="text-sm text-slate-500">Privacy and reporting settings for your organization. Only owners can see this page.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Settings />
      </Suspense>
    </div>
  );
}

async function Settings() {
  const [{ org, log }, now] = await Promise.all([privacySettings(), requestTime()]);
  return (
    <>
      <section className={card}>
        <h2 className="font-semibold">Privacy</h2>
        <PrivacyForm current={org} />
      </section>
      <section className={card}>
        <div>
          <h2 className="font-semibold">Reports</h2>
          <p className="text-sm text-slate-500">The working plan that utilization is measured against.</p>
        </div>
        <ReportPlanForm hours={org.plannedHoursPerDay} days={org.workingDays} />
      </section>
      <section className={card}>
        <div>
          <h2 className="font-semibold">Access log</h2>
          <p className="text-sm text-slate-500">
            When Veristart staff opened your organization (for support), and when operator data was downloaded or erased.
          </p>
        </div>
        {log.length === 0 ? (
          <p className="text-sm text-slate-500">Nothing yet.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {log.map((e) => (
              <li key={e.id} className="flex flex-wrap justify-between gap-x-4 py-2">
                <span>
                  {ACTIONS[e.action] ?? e.action}
                  {e.detail && e.action !== "staff-view" && <span className="text-slate-500"> · {e.detail}</span>}
                  <span className="block text-xs text-slate-500">{e.actor}</span>
                </span>
                <span className="text-slate-500" title={e.at.toISOString()}>
                  {timeAgo(e.at, now)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
