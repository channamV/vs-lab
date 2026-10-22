import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { firmwareRolloutForStaff, requestTime } from "@/lib/data";
import { machineLabel, timeAgo } from "@/lib/format";
import { cancelUpdatesAction, retireReleaseAction } from "../actions";
import { Rollout } from "./Rollout";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

/** Veristart staff only: one firmware release, and sending it to devices in stages. */
export default function ReleasePage({ params }: PageProps<"/platform/firmware/[id]">) {
  return (
    <div className="space-y-6">
      <Link href="/platform/firmware" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Firmware
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading release…</p>}>
        <Release params={params} />
      </Suspense>
    </div>
  );
}

async function Release({ params }: Pick<PageProps<"/platform/firmware/[id]">, "params">) {
  const id = Number((await params).id);
  if (!Number.isSafeInteger(id) || id <= 0) notFound();
  const [data, now] = await Promise.all([firmwareRolloutForStaff(id), requestTime()]);
  if (!data) notFound();
  const { release, devices } = data;
  const counts = (s: string) => devices.filter((d) => d.update?.state === s).length;
  const waiting = counts("waiting") + counts("sent");

  return (
    <>
      <div>
        <h1 className="font-mono text-2xl font-semibold">
          {release.version}
          {release.retiredAt && <span className="ml-2 align-middle font-sans text-sm text-slate-500">(retired)</span>}
        </h1>
        <p className="text-sm text-slate-500">
          {release.fileName} · {(release.bytes / 1e6).toFixed(2)} MB · uploaded {timeAgo(release.createdAt, now)} by {release.uploadedBy}
        </p>
        <p className="mt-1 break-all font-mono text-xs text-slate-500">SHA-256 {release.sha256}</p>
        {release.notes && <p className="mt-2 whitespace-pre-line text-sm">{release.notes}</p>}
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-semibold">Send to devices</h2>
            <p className="text-sm text-slate-500">
              {devices.filter((d) => d.firmwareVersion === release.version).length} running it · {counts("done")} updated · {waiting} waiting ·{" "}
              {counts("failed") + counts("expired")} failed
            </p>
          </div>
          <div className="flex gap-2">
            {waiting > 0 && (
              <form action={cancelUpdatesAction}>
                <input type="hidden" name="releaseId" value={release.id} />
                <button className="rounded border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
                  Cancel {waiting} waiting
                </button>
              </form>
            )}
            {!release.retiredAt && (
              <form action={retireReleaseAction}>
                <input type="hidden" name="releaseId" value={release.id} />
                <button className="rounded border border-red-300 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
                  Retire release
                </button>
              </form>
            )}
          </div>
        </div>
        <ol className="list-inside list-decimal text-sm text-slate-600 dark:text-slate-400">
          <li>Send it to one bench device and check it updates and keeps reporting.</li>
          <li>Then a few pilot machines; leave them a day.</li>
          <li>Then everyone left (filter by organization if you want to go customer by customer).</li>
        </ol>
        <Rollout
          releaseId={release.id}
          version={release.version}
          retired={release.retiredAt !== null}
          devices={devices.map((d) => ({
            id: d.id,
            firmwareVersion: d.firmwareVersion,
            lastSeen: timeAgo(d.lastSeenAt, now),
            where: d.machineName ? machineLabel({ name: d.machineName, unitNumber: d.unitNumber }) : "Not on a machine",
            organization: d.stockOrganization ?? "Veristart stock",
            update: d.update ? { state: d.update.state, at: d.update.at.toISOString(), result: d.update.result } : null,
          }))}
        />
      </section>
    </>
  );
}
