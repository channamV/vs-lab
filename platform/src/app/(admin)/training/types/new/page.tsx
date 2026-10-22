import { Suspense } from "react";
import { TypePage } from "../TypePage";

export default function NewCertificationPage() {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <TypePage id={null} />
    </Suspense>
  );
}
