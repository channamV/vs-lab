import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { maintenanceIssue, maintenancePlaces } from "@/lib/data";
import { clockTime } from "@/lib/format";
import { SECTIONS, type Section } from "@/lib/maintenance-types";
import { localDateKey } from "@/lib/telemetry/engine";
import { deleteIssueAction, removeAttachmentAction } from "../../actions";
import { age, card, IssueChip, PriorityBadge, SOURCE_ICON, sourceLabel, statusLabel } from "../../ui";
import { AttachmentUpload, IssueForm } from "./IssueForms";

/**
 * The issue card (docs/maintenance.md): what was reported (every checklist that reported it, with photos), where,
 * the three C's, files, and the activity log. One column, built for a mechanic's phone.
 */
export default function IssuePage({ params }: PageProps<"/maintenance/issues/[id]">) {
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link href="/maintenance" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← Maintenance
      </Link>
      <Suspense fallback={<p className="text-sm text-slate-500">Loading…</p>}>
        <Issue params={params} />
      </Suspense>
    </div>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  major: "text-red-700 dark:text-red-400",
  minor: "text-amber-700 dark:text-amber-400",
};

const mapsLink = (lat: number, lng: number) => `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;

async function Issue({ params }: { params: PageProps<"/maintenance/issues/[id]">["params"] }) {
  const id = Number((await params).id);
  const data = Number.isSafeInteger(id) && id > 0 ? await maintenanceIssue(id) : null;
  if (!data) notFound();
  const { issue, machine, worksite, reports, attachments, activity, schedule, readings, vendors, otherOpen, now, timeZone, canEdit } = data;
  const resolved = issue.resolvedAt !== null;
  const [reportedPlace, nowPlace] = await maintenancePlaces([
    { lat: issue.lat, lng: issue.lng },
    { lat: machine.lat, lng: machine.lng },
  ]);
  const moved = issue.lat !== null && machine.lat !== null && (Math.abs(issue.lat - machine.lat!) > 0.0005 || Math.abs(issue.lng! - machine.lng!) > 0.0005);
  const photoCount = reports.reduce((n, r) => n + r.photoIds.length, 0);
  return (
    <>
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-sm text-slate-500">#{issue.number}</span>
          <PriorityBadge priority={issue.priority} resolved={resolved} />
          <span className="rounded-full border border-slate-300 px-2 py-0.5 text-xs dark:border-slate-700">{statusLabel(issue.status)}</span>
        </div>
        <h1 className="text-2xl font-semibold">{issue.title}</h1>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          <Link href={`/machines/${machine.id}`} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
            {machine.label}
          </Link>{" "}
          · {SOURCE_ICON[issue.source]} {sourceLabel(issue.source)} · opened {clockTime(issue.firstReportedAt, timeZone, now)} ({age(issue.firstReportedAt, now)})
          {resolved && <> · resolved {clockTime(issue.resolvedAt!, timeZone, now)}</>}
        </p>
      </header>

      {machine.lockedOutAt && !resolved && (
        <p className="rounded-lg border-2 border-red-400 bg-red-50 p-3 text-sm font-medium text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          🔒 This machine is locked out for repair. Resolving its last &ldquo;Locked out&rdquo; item clears the lockout.
        </p>
      )}

      <section className={`${card} space-y-1 p-4 text-sm`}>
        <h2 className="font-semibold">Where</h2>
        {issue.lat !== null && issue.lng !== null ? (
          <p>
            <span className="text-slate-500">When reported: </span>
            <a href={mapsLink(issue.lat, issue.lng)} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-400">
              {reportedPlace ?? `${issue.lat.toFixed(5)}, ${issue.lng.toFixed(5)}`}
            </a>
            {!moved && machine.lat !== null && <span className="text-slate-500"> · still there</span>}
          </p>
        ) : (
          <p className="text-slate-500">No position when it was reported.</p>
        )}
        {moved && machine.lat !== null && machine.lng !== null && (
          <p>
            <span className="text-slate-500">Machine now: </span>
            <a href={mapsLink(machine.lat, machine.lng)} target="_blank" rel="noreferrer" className="text-sky-700 hover:underline dark:text-sky-400">
              {nowPlace ?? `${machine.lat.toFixed(5)}, ${machine.lng.toFixed(5)}`}
            </a>
            {machine.lastFixAt && <span className="text-slate-500"> · {clockTime(machine.lastFixAt, timeZone, now)}</span>}
          </p>
        )}
        {worksite && <p className="text-slate-500">Worksite: {worksite.name}</p>}
      </section>

      {reports.length > 0 && (
        <section className={`${card} space-y-3 p-4`}>
          <h2 className="font-semibold">
            Checklist reports ({reports.length}){photoCount > 0 && <span className="font-normal text-slate-500"> · {photoCount} photo{photoCount === 1 ? "" : "s"}</span>}
          </h2>
          <ol className="space-y-3">
            {reports.map((r) => (
              <li key={r.id} className="space-y-1 border-l-2 border-slate-200 pl-3 text-sm dark:border-slate-700">
                <p>
                  <span className="text-slate-500">{clockTime(r.reportedAt, timeZone, now)}</span> · {r.operatorName ?? "Operator (record removed)"}
                  {r.checkinId && (
                    <>
                      {" "}
                      ·{" "}
                      <Link href={`/checklists/results/${r.checkinId}`} className="text-sky-700 hover:underline dark:text-sky-400">
                        checklist
                      </Link>
                    </>
                  )}
                </p>
                <p className={`font-medium ${SEVERITY_STYLE[r.severity] ?? ""}`}>
                  {r.answerLabel}
                  {r.note && <span className="font-normal text-slate-700 dark:text-slate-300">: &ldquo;{r.note}&rdquo;</span>}
                </p>
                {r.photoIds.length > 0 && (
                  <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                    {r.photoIds.map((p) => (
                      <a key={p} href={`/photos/${p}`} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element -- private photo served by /photos/<id> */}
                        <img src={`/photos/${p}`} alt={`Photo: ${issue.title}`} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                      </a>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </section>
      )}

      {schedule && (
        <section className={`${card} p-4 text-sm`}>
          <p>
            🛠️ From the service schedule{" "}
            <Link href={`/maintenance/schedules/${schedule.id}`} className="text-sky-700 hover:underline dark:text-sky-400">
              {schedule.description}
            </Link>
            . Machine now: {[readings.hours && `${readings.hours.value.toLocaleString("en-CA")} h`, readings.km && `${readings.km.value.toLocaleString("en-CA")} km`].filter(Boolean).join(" · ") || "no reading yet"}.
          </p>
        </section>
      )}

      <section className={`${card} space-y-3 p-4`}>
        {canEdit ? (
          <IssueForm
            issue={{
              id: issue.id,
              status: issue.status,
              priority: issue.priority,
              title: issue.title,
              complaint: issue.complaint,
              cause: issue.cause,
              correction: issue.correction,
              performedBy: issue.performedBy,
              vendorName: issue.vendorName,
              servicedHours: issue.servicedHours,
              servicedKm: issue.servicedKm,
              servicedOn: issue.servicedOn,
              resolved,
            }}
            vendors={vendors}
            service={
              schedule
                ? {
                    hours: readings.hours?.value ?? null,
                    km: readings.km?.value ?? null,
                    today: localDateKey(now, timeZone),
                    usesHours: Boolean(schedule.everyHours),
                    usesKm: Boolean(schedule.everyKm),
                  }
                : null
            }
          />
        ) : (
          <dl className="space-y-3 text-sm">
            {(Object.keys(SECTIONS) as Section[]).map((k) => (
              <div key={k}>
                <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{SECTIONS[k].label}</dt>
                <dd className="whitespace-pre-wrap">{issue[k] || "—"}</dd>
              </div>
            ))}
            {issue.performedBy && (
              <div>
                <dt className="text-xs font-semibold tracking-wide text-slate-500 uppercase">Work done by</dt>
                <dd>{issue.performedBy === "vendor" ? `Vendor${issue.vendorName ? `: ${issue.vendorName}` : ""}` : "Our technician"}</dd>
              </div>
            )}
          </dl>
        )}
      </section>

      <section className={`${card} space-y-3 p-4`}>
        <h2 className="font-semibold">Photos and files</h2>
        {attachments.length === 0 && <p className="text-sm text-slate-500">None yet.</p>}
        {(Object.keys(SECTIONS) as Section[]).map((k) => {
          const list = attachments.filter((a) => a.section === k);
          if (!list.length) return null;
          return (
            <div key={k} className="space-y-1">
              <h3 className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{SECTIONS[k].label}</h3>
              <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4">
                {list.map((a) => (
                  <li key={a.id} className="relative">
                    <a href={`/maintenance/files/${a.id}`} target="_blank" rel="noreferrer" className="block">
                      {a.contentType.startsWith("image/") ? (
                        // eslint-disable-next-line @next/next/no-img-element -- private file served by /maintenance/files/<id>
                        <img src={`/maintenance/files/${a.id}`} alt={a.filename} loading="lazy" className="aspect-square w-full rounded-lg object-cover" />
                      ) : (
                        <span className="flex aspect-square w-full flex-col items-center justify-center rounded-lg border border-slate-200 p-1 text-center text-xs break-all dark:border-slate-700">
                          📄 {a.filename}
                        </span>
                      )}
                    </a>
                    {canEdit && (
                      <form action={removeAttachmentAction} className="absolute -top-2 -right-2">
                        <input type="hidden" name="issueId" value={issue.id} />
                        <input type="hidden" name="attachmentId" value={a.id} />
                        <button className="h-7 w-7 rounded-full bg-slate-800 text-xs text-white" aria-label={`Remove ${a.filename}`}>
                          ✕
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
        {canEdit && <AttachmentUpload issueId={issue.id} />}
      </section>

      {otherOpen.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Other open items on this machine</h2>
          {otherOpen.map((o) => (
            <IssueChip key={o.id} issue={o} />
          ))}
        </section>
      )}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Activity</h2>
        <ol className="space-y-1 text-sm">
          {activity.map((a) => (
            <li key={a.id} className="flex gap-2">
              <span className="shrink-0 text-slate-500">{clockTime(a.at, timeZone, now)}</span>
              <span>
                {a.detail}
                <span className="text-slate-500"> · {a.email ?? "VS-lab"}</span>
              </span>
            </li>
          ))}
        </ol>
      </section>

      {canEdit && (
        <details className="text-sm">
          <summary className="cursor-pointer text-slate-500">Delete this item</summary>
          <form action={deleteIssueAction} className="mt-2 space-y-2">
            <input type="hidden" name="issueId" value={issue.id} />
            <p className="text-slate-600 dark:text-slate-400">Deleting removes it and its files for good. To close finished work, resolve it instead.</p>
            <button className="rounded-lg border border-red-300 px-3 py-2 font-medium text-red-700 hover:bg-red-50 dark:border-red-800 dark:text-red-400 dark:hover:bg-red-950">
              Delete #{issue.number}
            </button>
          </form>
        </details>
      )}
    </>
  );
}
