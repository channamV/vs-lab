import { notFound } from "next/navigation";
import { Suspense } from "react";
import { TypePage } from "../TypePage";

export default function EditCertificationPage({ params }: PageProps<"/training/types/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <Edit params={params} />
    </Suspense>
  );
}

async function Edit({ params }: { params: PageProps<"/training/types/[id]">["params"] }) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  return <TypePage id={id} />;
}
