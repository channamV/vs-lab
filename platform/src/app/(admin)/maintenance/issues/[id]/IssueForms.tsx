"use client";

import { useActionState, useState } from "react";
import { missingForResolve, PRIORITIES, PRIORITY_CHOICES, SECTIONS, STATUSES, type Section, type Status } from "@/lib/maintenance-types";
import { shrinkPhoto } from "@/lib/shrink-photo";
import { saveIssueAction, uploadAttachmentAction, type FormState } from "../../actions";

const idle: FormState = { status: "idle" };
const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900";
const label = "block text-sm font-medium";

export type EditableIssue = {
  id: number;
  status: string;
  priority: string;
  title: string;
  complaint: string;
  cause: string | null;
  correction: string | null;
  performedBy: string | null;
  vendorName: string | null;
  servicedHours: number | null;
  servicedKm: number | null;
  servicedOn: string | null;
  resolved: boolean;
};

/**
 * The issue card's form: status, priority and the three C's, who did the work, and (service items) the reading at
 * service. Save and Mark resolved stay at the bottom of the screen on a phone. Fields keep what was typed if the
 * server says no.
 */
export function IssueForm({
  issue,
  vendors,
  service,
}: {
  issue: EditableIssue;
  vendors: string[];
  /** Service items: the machine's current readings (the defaults for "reading at service") and today's date. */
  service: { hours: number | null; km: number | null; today: string; usesKm: boolean; usesHours: boolean } | null;
}) {
  const [state, action, pending] = useActionState(saveIssueAction, idle);
  const v = state.status === "error" ? state.values : undefined;
  const [c3, setC3] = useState({
    complaint: v?.complaint ?? issue.complaint,
    cause: v?.cause ?? issue.cause ?? "",
    correction: v?.correction ?? issue.correction ?? "",
  });
  const [performedBy, setPerformedBy] = useState(v?.performedBy ?? issue.performedBy ?? "");
  const missing = missingForResolve(c3);
  return (
    <form key={state.attempt} action={action} className="space-y-4">
      <input type="hidden" name="issueId" value={issue.id} />
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1">
          <span className={label}>Status</span>
          <select name="status" defaultValue={v?.status ?? issue.status} className={field}>
            {(Object.keys(STATUSES) as Status[]).map((s) => (
              <option key={s} value={s}>
                {STATUSES[s].label}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className={label}>Priority</span>
          <select name="priority" defaultValue={v?.priority ?? issue.priority} className={field}>
            {PRIORITY_CHOICES.map((p) => (
              <option key={p} value={p}>
                {PRIORITIES[p].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="block space-y-1">
        <span className={label}>Title</span>
        <input name="title" defaultValue={v?.title ?? issue.title} maxLength={200} required className={field} />
      </label>

      {(Object.keys(SECTIONS) as Section[]).map((k) => (
        <label key={k} className="block space-y-1">
          <span className="flex items-baseline justify-between gap-2">
            <span className={`${label} uppercase tracking-wide`}>{SECTIONS[k].label}</span>
            <span className="text-xs text-slate-500">{SECTIONS[k].help}</span>
          </span>
          <textarea
            name={k}
            rows={k === "complaint" ? 3 : 3}
            maxLength={4000}
            value={c3[k]}
            onChange={(e) => setC3((x) => ({ ...x, [k]: e.target.value }))}
            placeholder={k === "cause" ? "e.g. Cracked hose fitting at the boom cylinder" : k === "correction" ? "e.g. Replaced fitting and hose, topped up hydraulic oil, tested" : ""}
            className={field}
          />
        </label>
      ))}

      <fieldset className="space-y-2">
        <legend className={label}>Work done by</legend>
        <div className="flex flex-wrap gap-2">
          {[
            ["", "Not set"],
            ["internal", "Our technician"],
            ["vendor", "Outside vendor"],
          ].map(([value, text]) => (
            <label key={value} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 dark:border-slate-700">
              <input type="radio" name="performedBy" value={value} checked={performedBy === value} onChange={() => setPerformedBy(value)} />
              {text}
            </label>
          ))}
        </div>
        {performedBy === "vendor" && (
          <>
            <input name="vendorName" list="vendors" defaultValue={v?.vendorName ?? issue.vendorName ?? ""} maxLength={120} placeholder="Vendor's name" className={field} />
            <datalist id="vendors">
              {vendors.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
          </>
        )}
      </fieldset>

      {service && (
        <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
          <legend className="px-1 text-sm font-medium">Machine reading at the service</legend>
          <p className="text-xs text-slate-500">Sets when the next service is due. Leave empty to use the current reading and today.</p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            {service.usesHours && (
              <label className="space-y-1 text-sm">
                Hours
                <input
                  name="servicedHours"
                  inputMode="decimal"
                  defaultValue={v?.servicedHours ?? issue.servicedHours ?? ""}
                  placeholder={service.hours !== null ? String(service.hours) : ""}
                  className={field}
                />
              </label>
            )}
            {service.usesKm && (
              <label className="space-y-1 text-sm">
                Km
                <input name="servicedKm" inputMode="decimal" defaultValue={v?.servicedKm ?? issue.servicedKm ?? ""} placeholder={service.km !== null ? String(service.km) : ""} className={field} />
              </label>
            )}
            <label className="space-y-1 text-sm">
              Date
              <input type="date" name="servicedOn" defaultValue={v?.servicedOn ?? issue.servicedOn ?? ""} max={service.today} className={field} />
            </label>
          </div>
        </fieldset>
      )}

      {state.status === "error" && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{state.message}</p>}
      {state.status === "saved" && <p className="rounded-lg bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">✓ {state.message}</p>}

      {/* On a phone this bar stays at the bottom of the screen while scrolling through the card. */}
      <div className="sticky bottom-0 -mx-4 space-y-2 border-t border-slate-200 bg-white/95 px-4 py-3 backdrop-blur sm:static sm:mx-0 sm:border-0 sm:bg-transparent sm:px-0 sm:py-0 dark:border-slate-800 dark:bg-slate-950/95 sm:dark:bg-transparent">
        {!issue.resolved && (
          <p className={`text-sm ${missing.length ? "text-amber-700 dark:text-amber-400" : "text-emerald-700 dark:text-emerald-400"}`}>
            {missing.length ? `To resolve, fill in: ${missing.join(", ")}` : "✓ Ready to resolve"}
          </p>
        )}
        <div className="flex gap-2">
          <button name="intent" value="save" disabled={pending} className="min-h-11 flex-1 rounded-lg border border-slate-300 px-4 py-2 font-medium hover:bg-slate-50 disabled:opacity-50 sm:flex-none dark:border-slate-700 dark:hover:bg-slate-800">
            {pending ? "Saving…" : "Save"}
          </button>
          {!issue.resolved && (
            <button
              name="intent"
              value="resolve"
              disabled={pending || missing.length > 0}
              className="min-h-11 flex-1 rounded-lg bg-emerald-700 px-4 py-2 font-medium text-white hover:bg-emerald-800 disabled:opacity-50 sm:flex-none"
            >
              Mark resolved
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

/** Adds photos (shrunk on the phone) or PDFs to a section of the item. */
export function AttachmentUpload({ issueId }: { issueId: number }) {
  const [state, action, pending] = useActionState(uploadAttachmentAction, idle);
  const [busy, setBusy] = useState(false);
  return (
    <form
      key={state.attempt}
      action={async (formData) => {
        setBusy(true);
        // Photos from a phone camera are big: shrink them like checklist photos.
        const files = formData.getAll("file").filter((f): f is File => f instanceof File && f.size > 0);
        formData.delete("file");
        for (const f of files) formData.append("file", f.type.startsWith("image/") ? await shrinkPhoto(f) : f);
        setBusy(false);
        action(formData);
      }}
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <input type="hidden" name="issueId" value={issueId} />
      <select name="section" defaultValue="cause" aria-label="Add to" className="rounded-lg border border-slate-300 bg-transparent px-2 py-2 dark:border-slate-700">
        {(Object.keys(SECTIONS) as Section[]).map((s) => (
          <option key={s} value={s}>
            {SECTIONS[s].label}
          </option>
        ))}
      </select>
      <label className="flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border-2 border-dashed border-slate-300 px-3 dark:border-slate-700">
        📎 {busy || pending ? "Uploading…" : "Add photos or PDF"}
        <input
          type="file"
          name="file"
          accept="image/*,application/pdf"
          multiple
          className="sr-only"
          onChange={(e) => {
            if (e.target.files?.length) e.target.form?.requestSubmit();
          }}
        />
      </label>
      {state.status === "error" && <span className="text-red-700 dark:text-red-400">{state.message}</span>}
    </form>
  );
}
