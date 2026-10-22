import Link from "next/link";
import { Suspense } from "react";
import { firmwareReleasesForStaff, requestTime } from "@/lib/data";
import { timeAgo } from "@/lib/format";
import { UploadForm } from "./UploadForm";

const card = "space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900";

/** Veristart staff only: firmware releases and over-the-air updates (docs/firmware-updates.md). */
export default function FirmwarePage() {
  return (
    <div className="space-y-6">
      <Link href="/platform" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Platform
      </Link>
      <div>
        <h1 className="text-2xl font-semibold">Firmware</h1>
        <p className="text-sm text-slate-500">
          Upload a build, then send it to devices in stages: one bench device, a few pilot machines, then everyone. Only our own
          firmware can install updates; devices on the stock Telelogger ignore them.
        </p>
      </div>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Releases />
      </Suspense>
      <section className={card}>
        <h2 className="font-semibold">Upload a release</h2>
        <UploadForm />
      </section>
    </div>
  );
}

async function Releases() {
  const [releases, now] = await Promise.all([firmwareReleasesForStaff(), requestTime()]);
  return (
    <section className={card}>
      <h2 className="font-semibold">Releases</h2>
      {releases.length === 0 ? (
        <p className="text-sm text-slate-500">None yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="py-1 pr-3">Version</th>
                <th className="py-1 pr-3">Uploaded</th>
                <th className="py-1 pr-3">Size</th>
                <th className="py-1 pr-3">Devices running it</th>
                <th className="py-1 pr-3">Updates</th>
              </tr>
            </thead>
            <tbody>
              {releases.map((r) => (
                <tr key={r.id} className="border-t border-slate-100 dark:border-slate-800">
                  <td className="py-2 pr-3">
                    <Link href={`/platform/firmware/${r.id}`} className="font-mono font-medium text-sky-700 hover:underline dark:text-sky-400">
                      {r.version}
                    </Link>
                    {r.retiredAt && <span className="ml-2 rounded bg-slate-100 px-1.5 text-xs text-slate-600 dark:bg-slate-800">retired</span>}
                    {r.notes && <div className="max-w-md truncate text-xs text-slate-500">{r.notes}</div>}
                  </td>
                  <td className="py-2 pr-3 text-slate-500">
                    {timeAgo(r.createdAt, now)} · {r.uploadedBy}
                  </td>
                  <td className="py-2 pr-3 tabular-nums">{(r.bytes / 1e6).toFixed(2)} MB</td>
                  <td className="py-2 pr-3 tabular-nums">{r.running}</td>
                  <td className="py-2 pr-3 text-slate-600 dark:text-slate-400">
                    {r.updates.waiting + r.updates.done + r.updates.failed === 0
                      ? "—"
                      : `${r.updates.done} done · ${r.updates.waiting} waiting${r.updates.failed ? ` · ${r.updates.failed} failed` : ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
