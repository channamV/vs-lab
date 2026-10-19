import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { subscriptionSettings } from "@/lib/data";
import { ALERT_LABELS } from "@/lib/alerts";
import { machineLabel } from "@/lib/format";
import { AddSubscriptionForm } from "./AddSubscriptionForm";
import { removeSubscriptionAction } from "./actions";

/** Choose which alerts you're emailed about. Owners open it for another user with ?user=<id>. */
export default function SubscriptionsPage({ searchParams }: PageProps<"/alerts/subscriptions">) {
  return (
    <div className="max-w-3xl space-y-6">
      <Link href="/alerts" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Alerts
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Settings searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Settings({ searchParams }: Pick<PageProps<"/alerts/subscriptions">, "searchParams">) {
  const raw = (await searchParams).user;
  const userId = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
  const settings = await subscriptionSettings(userId);
  if (!settings) notFound();
  const { user, isSelf, subscriptions } = settings;
  const who = user.name ?? user.email;

  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">{isSelf ? "My alert emails" : `Alert emails for ${who}`}</h1>
        <p className="text-sm text-slate-500">
          {isSelf ? "You're" : `${who} is`} emailed about the alerts below. Alerts only ever go to people who can see the
          machine, so division limits always apply.
        </p>
      </div>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">Subscriptions</h2>
        {subscriptions.length === 0 ? (
          <p className="text-sm text-slate-500">None: {isSelf ? "you don't" : `${who} doesn't`} get any alert emails.</p>
        ) : (
          <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">
            {subscriptions.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{s.what}</span> · {s.where} · <span className="text-slate-500">{s.how}</span>
                </span>
                <form action={removeSubscriptionAction}>
                  <input type="hidden" name="userId" value={user.id} />
                  <input type="hidden" name="subscriptionId" value={s.id} />
                  <button className="text-sm text-sky-700 hover:underline dark:text-sky-400">Remove</button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
        <h2 className="font-semibold">Add a subscription</h2>
        <AddSubscriptionForm
          userId={user.id}
          types={Object.entries(ALERT_LABELS).map(([value, label]) => ({ value, label }))}
          divisions={settings.divisions}
          machines={settings.machines.map((m) => ({ id: m.id, label: machineLabel(m) }))}
        />
        <p className="text-xs text-slate-500">
          Example: a mechanic might only want <em>Checklist issues</em> for all machines; a site supervisor every alert for
          one division.
        </p>
      </section>
    </>
  );
}
