import Link from "next/link";
import { notFound } from "next/navigation";
import { subscriptionForm } from "@/lib/data";
import { EVENT_TYPES, LATER_EVENT_TYPES } from "@/lib/notifications";
import { machineLabel } from "@/lib/format";
import { SubscriptionForm, type RuleValues } from "./SubscriptionForm";

/** Shared by /alerts/subscriptions/new and /alerts/subscriptions/<id>. `?user=` lets owners manage someone else's. */
export async function FormPage({ ruleId, userParam }: { ruleId: number | null; userParam: string | string[] | undefined }) {
  const userId = typeof userParam === "string" && /^\d+$/.test(userParam) ? Number(userParam) : undefined;
  const data = await subscriptionForm(ruleId, userId);
  if (!data) notFound();
  const { user, isSelf, rule, choices } = data;
  const back = isSelf ? "/alerts/subscriptions" : `/alerts/subscriptions?user=${user.id}`;
  const initial: RuleValues = rule
    ? {
        name: rule.name,
        eventTypes: rule.eventTypes,
        machineIds: rule.machineIds,
        divisionIds: rule.divisionIds,
        operatorIds: rule.operatorIds,
        weekdays: rule.weekdays,
        startTime: rule.startTime,
        endTime: rule.endTime,
      }
    : { name: "", eventTypes: [], machineIds: [], divisionIds: [], operatorIds: [], weekdays: [], startTime: "", endTime: "" };

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">{rule ? "Edit subscription" : "New subscription"}</h1>
          <p className="text-sm text-slate-500">
            {isSelf ? "Choose which events you're emailed about." : `Alerts for ${user.name ?? user.email}.`}
          </p>
        </div>
        <Link href={back} className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← Subscriptions
        </Link>
      </div>
      <SubscriptionForm
        userId={user.id}
        ruleId={rule?.id ?? null}
        initial={initial}
        eventTypes={Object.entries(EVENT_TYPES).map(([value, e]) => ({ value, label: e.label, description: e.description }))}
        laterEventTypes={LATER_EVENT_TYPES}
        machines={choices.machines.map((m) => ({ id: m.id, label: machineLabel(m) }))}
        divisions={choices.divisions.map((d) => ({ id: d.id, label: d.name }))}
        operators={choices.operators.map((o) => ({
          id: o.id,
          label: o.name,
          hint: [o.employeeNumber && `#${o.employeeNumber}`, !o.active && "inactive"].filter(Boolean).join(" · ") || undefined,
        }))}
        timeZone={choices.timeZone}
        email={user.email}
        cancelHref={back}
      />
    </div>
  );
}
