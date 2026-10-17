import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { machineIdForCode } from "@/lib/data";

/**
 * Old links (alert emails, bookmarks) used /devices/<device ID>. Each of those devices became a machine
 * whose code is that ID, so send the user to the machine.
 */
export default function OldDeviceLink({ params }: PageProps<"/devices/[id]">) {
  return (
    <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
      <Redirect params={params} />
    </Suspense>
  );
}

async function Redirect({ params }: Pick<PageProps<"/devices/[id]">, "params">) {
  const machineId = await machineIdForCode(decodeURIComponent((await params).id));
  if (!machineId) notFound();
  return redirect(`/machines/${machineId}`);
}
