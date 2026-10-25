import { Suspense } from "react";
import { currentUser, postedLimitCoverage, privacySettings, requestTime } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { PrivacyForm } from "./PrivacyForm";
import { ReportPlanForm } from "./ReportPlanForm";
import { SafetyForm } from "./SafetyForm";
import { ScheduleSettingsForm } from "./ScheduleSettingsForm";
import { ScanSettingsForm } from "./ScanSettingsForm";

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
        <p className="text-sm text-slate-500">Privacy, safety, schedule, scanning and reporting settings for your organization. Only owners can see this page.</p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Settings />
      </Suspense>
    </div>
  );
}

async function Settings() {
  const [{ org, log }, now, auth] = await Promise.all([privacySettings(), requestTime(), currentUser()]);
  return (
    <>
      <section className={card}>
        <h2 className="font-semibold">Privacy</h2>
        <PrivacyForm current={org} />
      </section>
      <section className={card}>
        <div>
          <h2 className="font-semibold">Safety rules</h2>
          <p className="text-sm text-slate-500">Speeding, excessive idling and operator fatigue. Each occurrence goes in Reports → Safety.</p>
        </div>
        <SafetyForm current={org} />
        <Suspense>
          <PostedLimitCoverage />
        </Suspense>
      </section>
      <section className={card}>
        <div>
          <h2 className="font-semibold">Time zone and schedules</h2>
          <p className="text-sm text-slate-500">The company's time zone, and how overlapping schedules are resolved.</p>
        </div>
        <ScheduleSettingsForm
          timezone={org.timezone}
          rule={org.scheduleConflictRule === "most_restrictive" ? "most_restrictive" : "least_restrictive"}
          staff={auth?.isPlatformAdmin ?? false}
        />
      </section>
      <section className={card}>
        <div>
          <h2 className="font-semibold">Scanning documents</h2>
          <p className="text-sm text-slate-500">&ldquo;Scan to fill&rdquo; reads training certificates (and serial plates) from a photo.</p>
        </div>
        <ScanSettingsForm retain={org.retainScanImages} />
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

/** Road km driven by on-road vehicles, by whether OpenStreetMap had the posted limit (to judge paid map data). */
async function PostedLimitCoverage() {
  const { months, onRoad } = await postedLimitCoverage();
  return (
    <div className="space-y-2 border-t border-slate-200 pt-3 text-sm dark:border-slate-800">
      <h3 className="font-medium">Posted speed limit coverage</h3>
      <p className="text-slate-500">
        Road kilometres driven by on-road vehicles ({onRoad} machine{onRoad === 1 ? "" : "s"}) where OpenStreetMap had the posted limit. Only
        those kilometres can be checked; if the share stays low on your routes, paid map data (e.g. TomTom) would cover more.
      </p>
      {months.length === 0 ? (
        <p className="text-slate-500">Nothing yet: it fills in once the tolerance is set and on-road vehicles drive.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full tabular-nums">
            <thead className="text-left text-slate-500">
              <tr>
                <th className="py-1 pr-3 font-normal">Month</th>
                <th className="py-1 pr-3 text-right font-normal">Road km</th>
                <th className="py-1 pr-3 text-right font-normal">Limit known</th>
                <th className="py-1 pr-3 text-right font-normal">Limit unknown</th>
                <th className="py-1 text-right font-normal">Off-road km</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => {
                const road = m.knownKm + m.unknownKm;
                const pct = road > 0 ? Math.round((m.knownKm / road) * 100) : null;
                return (
                  <tr key={m.month} className="border-t border-slate-100 dark:border-slate-800">
                    <td className="py-1 pr-3">{m.month}</td>
                    <td className="py-1 pr-3 text-right">{road.toFixed(0)}</td>
                    <td className="py-1 pr-3 text-right">
                      {m.knownKm.toFixed(0)} {pct !== null && <span className="text-slate-500">({pct}%)</span>}
                    </td>
                    <td className="py-1 pr-3 text-right">{m.unknownKm.toFixed(0)}</td>
                    <td className="py-1 text-right">{m.offRoadKm.toFixed(0)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-slate-500">Speed limit data © OpenStreetMap contributors (ODbL).</p>
    </div>
  );
}
