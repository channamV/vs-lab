import Link from "next/link";
import { Suspense } from "react";
import { AutoRefresh } from "@/components/AutoRefresh";
import { acknowledgedAlerts, companyTimeZone, openAlerts, requestTime } from "@/lib/data";
import { AlertList } from "./AlertList";
import { TestEmailButton } from "./TestEmailButton";

export default function AlertsPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Alerts</h1>
          <p className="text-sm text-slate-500">
            Unauthorized use and check-in problems on Safety &amp; Access Monitoring machines. New alerts are also emailed
            to the people subscribed to them.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Link href="/alerts/subscriptions" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
            My subscriptions
          </Link>
          <TestEmailButton />
        </div>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading alerts…</p>}>
        <Alerts />
      </Suspense>
    </div>
  );
}

async function Alerts() {
  const [open, done, now] = await Promise.all([openAlerts(), acknowledgedAlerts(30), requestTime()]);
  const tz = await companyTimeZone();
  return (
    <>
      <AutoRefresh seconds={20} />
      <section className="rounded-lg border border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="pt-2 font-semibold">Open ({open.length})</h2>
        {open.length === 0 ? (
          <p className="py-3 text-sm text-slate-500">No open alerts.</p>
        ) : (
          <AlertList alerts={open} timeZone={tz} now={now} />
        )}
      </section>
      {done.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white px-4 py-2 dark:border-slate-800 dark:bg-slate-900">
          <h2 className="pt-2 font-semibold text-slate-600 dark:text-slate-400">Recently acknowledged</h2>
          <AlertList alerts={done} timeZone={tz} now={now} />
        </section>
      )}
    </>
  );
}
