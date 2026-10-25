import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { companyTimeZone, requestTime, subscriptionList } from "@/lib/data";
import { EVENT_TYPES, type EventType } from "@/lib/notifications";
import { clockTime } from "@/lib/format";
import { DeleteRuleButton, EnabledSwitch } from "./RuleButtons";

/**
 * Notification subscriptions, laid out like the production portal: the rules on the left, and on the
 * right the last day's events with which rules matched them and what was emailed.
 * Owners open it for another user with ?user=<id>.
 */
export default function SubscriptionsPage({ searchParams }: PageProps<"/alerts/subscriptions">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <Subscriptions searchParams={searchParams} />
    </Suspense>
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const card = "rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

function daysText(days: number[]) {
  if (days.length === 0 || days.length === 7) return "Every day";
  const key = [...days].sort().join(",");
  if (key === "1,2,3,4,5") return "Mon–Fri";
  if (key === "0,6") return "Weekends";
  return [...days].sort().map((d) => DAYS[d]).join(", ");
}

async function Subscriptions({ searchParams }: Pick<PageProps<"/alerts/subscriptions">, "searchParams">) {
  const raw = (await searchParams).user;
  const userId = typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : undefined;
  const [data, now] = await Promise.all([subscriptionList(userId), requestTime()]);
  if (!data) notFound();
  const { user, isSelf, rules, activity, names } = data;
  const who = user.name ?? user.email;
  const q = isSelf ? "" : `?user=${user.id}`;
  const tz = await companyTimeZone();
  const machineName = new Map(names.machines.map((m) => [m.id, m.unitNumber ? `Unit ${m.unitNumber}` : m.name]));
  const operatorName = new Map(names.operators.map((o) => [o.id, o.name]));
  const divisionName = new Map(names.divisions.map((d) => [d.id, d.name]));
  const listed = (ids: number[], from: Map<number, string>, noun: string) =>
    ids.length <= 3 ? ids.map((id) => from.get(id) ?? "(no longer visible)").join(", ") : `${ids.length} ${noun}`;
  const active = rules.filter((r) => r.enabled).length;
  const matched = activity.filter((a) => a.matchingRules.length > 0).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/alerts" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
            ← Alerts
          </Link>
          <h1 className="text-2xl font-semibold">{isSelf ? "My subscriptions" : `Subscriptions for ${who}`}</h1>
          <p className="text-sm text-slate-500">
            {isSelf ? "Emails you get" : `Emails ${who} gets`} when things happen on the machines {isSelf ? "you" : "they"} can see.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-slate-800">{active} active</span>
          <span className="rounded-full bg-slate-100 px-2.5 py-1 dark:bg-slate-800">{rules.length} total</span>
          <Link href={`/alerts/subscriptions/new${q}`} className="rounded-lg bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800">
            + New
          </Link>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[3fr_2fr]">
        <section className="space-y-3">
          <h2 className="font-semibold">Subscriptions</h2>
          {rules.length === 0 && (
            <div className={`${card} text-sm text-slate-500`}>
              No subscriptions yet: {isSelf ? "you don't" : `${who} doesn't`} get any notification emails.{" "}
              <Link href={`/alerts/subscriptions/new${q}`} className="text-sky-700 hover:underline dark:text-sky-400">
                Create one
              </Link>
              .
            </div>
          )}
          {rules.map((r) => {
            const where = [
              r.machineIds.length ? listed(r.machineIds, machineName, "machines") : null,
              r.divisionIds.length ? `${listed(r.divisionIds, divisionName, "divisions")} division${r.divisionIds.length > 1 ? "s" : ""}` : null,
            ].filter(Boolean);
            const when = r.startTime ? `${daysText(r.weekdays)}, ${r.startTime}–${r.endTime}` : daysText(r.weekdays);
            return (
              <article key={r.id} className={`${card} space-y-2 ${r.enabled ? "" : "opacity-60"}`}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="font-semibold">
                    {r.name}
                    {!r.enabled && <span className="ml-2 text-xs font-normal text-slate-500">Paused</span>}
                  </h3>
                  <div className="flex items-center gap-4">
                    <EnabledSwitch userId={user.id} ruleId={r.id} enabled={r.enabled} />
                    <Link href={`/alerts/subscriptions/${r.id}${q}`} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
                      Edit
                    </Link>
                    <DeleteRuleButton userId={user.id} ruleId={r.id} name={r.name} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {r.eventTypes.map((t) => (
                    <span key={t} className="rounded-full border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700">
                      {EVENT_TYPES[t as EventType]?.label ?? t}
                    </span>
                  ))}
                </div>
                <p className="text-sm text-slate-600 dark:text-slate-400">
                  {where.length ? where.join(" + ") : "All machines"} ·{" "}
                  {r.operatorIds.length ? listed(r.operatorIds, operatorName, "operators") : "All operators"} · {when}
                </p>
                <p className="text-xs text-slate-500">✉ {user.email}</p>
              </article>
            );
          })}
        </section>

        <section className="space-y-3">
          <div>
            <h2 className="font-semibold">Last 24 hours</h2>
            <p className="text-xs text-slate-500">
              {activity.length} events · {active} active rule{active === 1 ? "" : "s"} · {matched} matched
            </p>
          </div>
          <div className={`${card} divide-y divide-slate-100 p-0 dark:divide-slate-800`}>
            {activity.length === 0 && <p className="p-4 text-sm text-slate-500">No events in the last 24 hours.</p>}
            {activity.map((a) => (
              <div key={a.id} className="space-y-0.5 px-4 py-2.5 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{a.label}</span> · {a.machine}
                  </span>
                  <span className="text-xs text-slate-500">{clockTime(a.occurredAt, tz, now)}</span>
                </div>
                {a.operatorName && <div className="text-xs text-slate-500">Operator: {a.operatorName}</div>}
                <div className="text-xs">
                  {a.delivery ? (
                    <span className={a.delivery.status === "sent" ? "text-emerald-700 dark:text-emerald-400" : "text-amber-700 dark:text-amber-400"}>
                      {a.delivery.status === "sent" ? "✉ Emailed" : a.delivery.status === "failed" ? "✉ Email failed" : "✉ Email not set up"} ·{" "}
                      {a.delivery.ruleNames.join(", ")}
                    </span>
                  ) : a.matchingRules.length ? (
                    <span className="text-slate-600 dark:text-slate-400">Would match: {a.matchingRules.join(", ")} (no email at the time)</span>
                  ) : (
                    <span className="text-slate-400">No rule matches</span>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
