"use client";

import { useActionState, useState } from "react";
import type { CertificationType } from "@/lib/db/schema";
import { shrinkPhoto } from "@/lib/shrink-photo";
import { defaultExpiry } from "@/lib/training-status";
import { addCategoryAction, saveCertificationTypeAction, saveTrainingRecordAction, type TrainingFormState } from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const button = "rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";
const label = "text-slate-600 dark:text-slate-400";
const initial: TrainingFormState = { error: null, version: 0 };

type Option = { id: number; name: string };
const str = (v: string | string[] | undefined) => (typeof v === "string" ? v : undefined);

/** A Yes / No question with no default: the manager must answer it (Craig, 2026-10-22). */
function YesNo({ name, question, help, value }: { name: string; question: string; help: string; value: string }) {
  return (
    <fieldset className="rounded border border-slate-200 p-3 text-sm dark:border-slate-700">
      <legend className="px-1 font-medium">{question}</legend>
      <p className="text-xs text-slate-500">{help}</p>
      <div className="mt-2 flex gap-4">
        {(["yes", "no"] as const).map((v) => (
          <label key={v} className="flex items-center gap-1.5">
            <input type="radio" name={name} value={v} defaultChecked={value === v} required />
            {v === "yes" ? "Yes" : "No"}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/** Add or edit a certification type. */
export function CertificationTypeForm({ type, categories, machines }: { type: CertificationType | null; categories: Option[]; machines: Option[] }) {
  const [state, action, pending] = useActionState(saveCertificationTypeAction, initial);
  const v = state.values;
  const yn = (b: boolean | null | undefined) => (b === true ? "yes" : b === false ? "no" : "");
  // A type that's not in use (e.g. a starter) shows both questions blank: setting it up means answering them.
  const answered = type !== null && type.active;
  const chosenCats = new Set((v?.categoryIds as string[] | undefined) ?? type?.categoryIds.map(String) ?? []);
  const chosenMachines = new Set((v?.machineIds as string[] | undefined) ?? type?.machineIds.map(String) ?? []);
  return (
    <form key={state.version} action={action} className="space-y-4">
      {type && <input type="hidden" name="id" value={type.id} />}
      <label className="block text-sm">
        <span className={label}>Name</span>
        <input name="name" required maxLength={100} defaultValue={str(v?.name) ?? type?.name ?? ""} placeholder="e.g. Excavator operator" className={field} />
      </label>
      <label className="block text-sm">
        <span className={label}>Description (optional)</span>
        <textarea name="description" maxLength={500} rows={2} defaultValue={str(v?.description) ?? type?.description ?? ""} className={field} />
      </label>
      <div className="grid gap-3 sm:grid-cols-3">
        <label className="block text-sm">
          <span className={label}>Valid for (months; blank = no expiry)</span>
          <input name="validityMonths" inputMode="numeric" maxLength={3} defaultValue={str(v?.validityMonths) ?? type?.validityMonths?.toString() ?? ""} className={field} />
        </label>
        <label className="block text-sm">
          <span className={label}>Grace period after expiry (days)</span>
          <input name="graceDays" inputMode="numeric" maxLength={2} defaultValue={str(v?.graceDays) ?? type?.graceDays.toString() ?? "0"} className={field} />
        </label>
        <label className="block text-sm">
          <span className={label}>Remind (days before expiry)</span>
          <input name="reminderDays" maxLength={40} defaultValue={str(v?.reminderDays) ?? (type?.reminderDays ?? [60, 30, 7]).join(", ")} className={field} />
        </label>
      </div>

      <div className="space-y-2">
        <p className="text-sm font-medium">Machines it covers</p>
        <p className="text-xs text-slate-500">Choose categories (new machines in them are covered automatically) and/or specific machines.</p>
        <div className="grid gap-1 text-sm sm:grid-cols-2">
          {categories.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input type="checkbox" name="categoryIds" value={c.id} defaultChecked={chosenCats.has(String(c.id))} />
              {c.name}
            </label>
          ))}
        </div>
        {machines.length > 0 && (
          <details className="text-sm" open={chosenMachines.size > 0}>
            <summary className="cursor-pointer text-sky-700 dark:text-sky-400">Specific machines ({chosenMachines.size} chosen)</summary>
            <div className="mt-2 grid max-h-60 gap-1 overflow-y-auto sm:grid-cols-2">
              {machines.map((m) => (
                <label key={m.id} className="flex items-center gap-2">
                  <input type="checkbox" name="machineIds" value={m.id} defaultChecked={chosenMachines.has(String(m.id))} />
                  {m.name}
                </label>
              ))}
            </div>
          </details>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <YesNo
          name="autoGrant"
          question="Auto-grant access?"
          help="Yes: a valid record lets the operator check in on the machines it covers, without approving them machine by machine."
          value={str(v?.autoGrant) ?? (answered ? yn(type?.autoGrant) : "")}
        />
        <YesNo
          name="required"
          question="Required to operate?"
          help="Yes: without a valid record (or within the grace period), the operator can't check in on the machines it covers, even if approved."
          value={str(v?.required) ?? (answered ? yn(type?.required) : "")}
        />
      </div>

      <label className="flex items-center gap-2 text-sm">
        {/* Opening a type that's not in use ("Set up") is to turn it on. */}
        <input type="checkbox" name="active" defaultChecked={v ? v.active === "on" : true} />
        In use (unticked: kept for records, but it doesn&apos;t grant or block access and sends no reminders)
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Saving…" : "Save certification"}
      </button>
    </form>
  );
}

export function AddCategoryForm() {
  const [state, action, pending] = useActionState(addCategoryAction, initial);
  return (
    <form key={state.version} action={action} className="flex flex-wrap items-end gap-2">
      <label className="block text-sm">
        <span className={label}>New category</span>
        <input name="name" required maxLength={60} defaultValue={str(state.values?.name)} placeholder="e.g. Hydrovac truck" className={field} />
      </label>
      <button disabled={pending} className={button}>
        {pending ? "Adding…" : "Add"}
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}

type RecordValues = {
  id: number;
  certificationTypeId: number;
  issuedOn: string;
  expiresOn: string | null;
  provider: string | null;
  certificateNumber: string | null;
  notes: string | null;
  documentKey: string | null;
};

type RecordTypes = { id: number; name: string; validityMonths: number | null; active: boolean }[];

/**
 * Add or edit a training record. The expiry date fills itself from the issue date and the certification's validity
 * until the manager types their own (e.g. the date printed on the card).
 */
export function TrainingRecordForm({ operatorId, record, types }: { operatorId: number; record?: RecordValues; types: RecordTypes }) {
  const [state, action, pending] = useActionState(saveTrainingRecordAction, initial);
  return (
    // key: a fresh form after each submit (empty after an add; the typed values after an error)
    <form key={state.version} action={action} className="space-y-3">
      <RecordFields operatorId={operatorId} record={record} types={types} state={state} pending={pending} />
    </form>
  );
}

function RecordFields({
  operatorId,
  record,
  types,
  state,
  pending,
}: {
  operatorId: number;
  record?: RecordValues;
  types: RecordTypes;
  state: TrainingFormState;
  pending: boolean;
}) {
  const v = state.values;
  const [typeId, setTypeId] = useState(str(v?.certificationTypeId) ?? record?.certificationTypeId.toString() ?? "");
  const [issuedOn, setIssuedOn] = useState(str(v?.issuedOn) ?? record?.issuedOn ?? "");
  const [expiresOn, setExpiresOn] = useState(str(v?.expiresOn) ?? record?.expiresOn ?? "");
  const [expiryTyped, setExpiryTyped] = useState(Boolean(record || v?.expiresOn));
  const [preparing, setPreparing] = useState(false);
  const autoExpiry = (t: string, issued: string) => {
    if (expiryTyped) return;
    const type = types.find((x) => String(x.id) === t);
    setExpiresOn((type && defaultExpiry(issued, type.validityMonths)) ?? "");
  };
  const done = state.version > 0 && !state.error && !record;
  return (
    <>
      {record ? <input type="hidden" name="id" value={record.id} /> : <input type="hidden" name="operatorId" value={operatorId} />}
      <label className="block text-sm">
        <span className={label}>Certification</span>
        <select
          name="certificationTypeId"
          required
          value={typeId}
          onChange={(e) => {
            setTypeId(e.target.value);
            autoExpiry(e.target.value, issuedOn);
          }}
          className={field}
        >
          <option value="" disabled>
            Choose…
          </option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.active ? "" : " (not in use)"}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className={label}>Issued / completed on</span>
          <input
            type="date"
            name="issuedOn"
            required
            value={issuedOn}
            onChange={(e) => {
              setIssuedOn(e.target.value);
              autoExpiry(typeId, e.target.value);
            }}
            className={field}
          />
        </label>
        <label className="block text-sm">
          <span className={label}>Expires on (blank = doesn&apos;t expire)</span>
          <input
            type="date"
            name="expiresOn"
            value={expiresOn}
            onChange={(e) => {
              setExpiresOn(e.target.value);
              setExpiryTyped(true);
            }}
            className={field}
          />
        </label>
        <label className="block text-sm">
          <span className={label}>Training provider (optional)</span>
          <input name="provider" maxLength={120} defaultValue={str(v?.provider) ?? record?.provider ?? ""} className={field} />
        </label>
        <label className="block text-sm">
          <span className={label}>Certificate / card # (optional)</span>
          <input name="certificateNumber" maxLength={80} defaultValue={str(v?.certificateNumber) ?? record?.certificateNumber ?? ""} className={field} />
        </label>
      </div>
      <label className="block text-sm">
        <span className={label}>Notes (optional)</span>
        <input name="notes" maxLength={500} defaultValue={str(v?.notes) ?? record?.notes ?? ""} className={field} />
      </label>
      <label className="block text-sm">
        <span className={label}>
          {record?.documentKey ? "Replace the certificate (photo or PDF, optional)" : "Certificate (photo or PDF, optional)"}
        </span>
        <input
          type="file"
          name="document"
          accept="image/jpeg,image/png,image/webp,application/pdf"
          className="mt-1 block w-full text-sm"
          onChange={async (e) => {
            const input = e.currentTarget;
            const file = input.files?.[0];
            if (!file || file.type === "application/pdf") return;
            // Phone photos are 3–8 MB: shrink, keeping enough detail to read the card.
            setPreparing(true);
            const small = await shrinkPhoto(file, 2000, 0.85);
            const list = new DataTransfer();
            list.items.add(small);
            input.files = list.files;
            setPreparing(false);
          }}
        />
      </label>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      {done && <p className="text-sm text-emerald-700 dark:text-emerald-400">Saved.</p>}
      <button disabled={pending || preparing} className={button}>
        {pending ? "Saving…" : preparing ? "Preparing photo…" : record ? "Save" : "Add training record"}
      </button>
    </>
  );
}
