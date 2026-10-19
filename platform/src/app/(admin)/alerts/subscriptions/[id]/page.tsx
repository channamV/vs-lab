import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FormPage } from "../FormPage";

export default function EditSubscriptionPage(props: PageProps<"/alerts/subscriptions/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <Edit {...props} />
    </Suspense>
  );
}

async function Edit({ params, searchParams }: PageProps<"/alerts/subscriptions/[id]">) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  return <FormPage ruleId={id} userParam={(await searchParams).user} />;
}
