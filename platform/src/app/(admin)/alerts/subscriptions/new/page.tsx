import { Suspense } from "react";
import { FormPage } from "../FormPage";

export default function NewSubscriptionPage({ searchParams }: PageProps<"/alerts/subscriptions/new">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <New searchParams={searchParams} />
    </Suspense>
  );
}

async function New({ searchParams }: Pick<PageProps<"/alerts/subscriptions/new">, "searchParams">) {
  return <FormPage ruleId={null} userParam={(await searchParams).user} />;
}
