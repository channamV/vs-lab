"use client";

import { useActionState } from "react";
import { CHECKLIST } from "@/lib/checklist";
import { checkInAction, checkOutAction, type CheckinFormState } from "./actions";

const idle: CheckinFormState = { status: "idle" };

const inputClass =
  "w-full rounded border border-slate-300 bg-white px-3 py-2.5 text-lg tracking-widest dark:border-slate-700 dark:bg-slate-900";
const buttonClass = "w-full rounded bg-sky-700 px-4 py-3 text-lg font-medium text-white hover:bg-sky-800 disabled:opacity-60";

function PinInput() {
  return (
    <input
      name="pin"
      type="password"
      inputMode="numeric"
      pattern="[0-9]*"
      autoComplete="off"
      required
      maxLength={8}
      placeholder="Your PIN"
      className={inputClass}
    />
  );
}

function ErrorMessage({ state }: { state: CheckinFormState }) {
  if (state.status !== "error") return null;
  return <p className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{state.message}</p>;
}

export function CheckInForm({ deviceId }: { deviceId: string }) {
  const [state, action, pending] = useActionState(checkInAction, idle);

  if (state.status === "checked-in") {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950">
        <p className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">✓ Checked in: {state.operatorName}</p>
        {!state.authorized && (
          <p className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            You&apos;re not on the approved operator list for this machine. Your check-in was recorded. Talk to your
            supervisor before operating it.
          </p>
        )}
        {state.failedItems.length > 0 && (
          <div className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            <p className="font-medium">Reported as not OK (recorded for your supervisor):</p>
            <ul className="mt-1 list-disc pl-5">
              {state.failedItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="text-sm text-slate-600 dark:text-slate-400">Check out from this page when you finish your shift.</p>
      </div>
    );
  }

  const values = state.status === "error" ? state.values : undefined;
  return (
    // key: rebuild the form after an error so it shows the operator's previous answers again
    <form key={state.status === "error" ? state.attempt : 0} action={action} className="space-y-4">
      <input type="hidden" name="deviceId" value={deviceId} />
      <label className="block space-y-1">
        <span className="font-medium">1. Your PIN</span>
        <PinInput />
      </label>

      <fieldset className="space-y-2">
        <legend className="font-medium">2. Pre-start checklist</legend>
        {CHECKLIST.map((item) => (
          <div key={item.id} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
            <p>{item.question}</p>
            <div className="mt-2 grid grid-cols-2 gap-2">
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-slate-300 py-2 has-checked:border-emerald-600 has-checked:bg-emerald-50 dark:border-slate-700 dark:has-checked:bg-emerald-950">
                <input
                  type="radio"
                  name={`item:${item.id}`}
                  value="ok"
                  required
                  defaultChecked={values?.answers[item.id] === "ok"}
                  className="accent-emerald-600"
                />
                OK
              </label>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded border border-slate-300 py-2 has-checked:border-red-600 has-checked:bg-red-50 dark:border-slate-700 dark:has-checked:bg-red-950">
                <input
                  type="radio"
                  name={`item:${item.id}`}
                  value="no"
                  defaultChecked={values?.answers[item.id] === "no"}
                  className="accent-red-600"
                />
                Not OK
              </label>
            </div>
          </div>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">3. Notes (optional)</span>
        <textarea
          name="notes"
          rows={3}
          maxLength={1000}
          defaultValue={values?.notes}
          placeholder="Anything your supervisor should know"
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>

      <ErrorMessage state={state} />
      <button disabled={pending} className={buttonClass}>
        {pending ? "Checking in…" : "Check in"}
      </button>
    </form>
  );
}

export function CheckOutForm({ deviceId }: { deviceId: string }) {
  const [state, action, pending] = useActionState(checkOutAction, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      <PinInput />
      <ErrorMessage state={state} />
      <button disabled={pending} className="w-full rounded border border-slate-400 px-4 py-2.5 font-medium disabled:opacity-60">
        {pending ? "Checking out…" : "Check out"}
      </button>
    </form>
  );
}
