import { Suspense } from "react";
import { getCheckinMachine } from "@/lib/checkin-page";
import { appTimeZone } from "@/lib/telemetry/engine";
import { clockTime } from "@/lib/format";
import { CheckInForm, CheckOutForm } from "./CheckinForms";

/** PUBLIC page opened from the QR sticker on a machine. No sign-in; operators identify with their PIN. */
export default function CheckinPage({ params, searchParams }: PageProps<"/checkin/[id]">) {
  return (
    <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
      <Checkin params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function Checkin({ params, searchParams }: Pick<PageProps<"/checkin/[id]">, "params" | "searchParams">) {
  const id = decodeURIComponent((await params).id);
  const checkedOut = (await searchParams).checkedOut === "1";
  const machine = await getCheckinMachine(id);
  if (!machine) {
    return (
      <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center dark:border-slate-700">
        This machine isn&apos;t set up for check-in. Tell your supervisor.
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{machine.unitNumber ? `Unit ${machine.unitNumber}` : machine.name}</h1>
        {machine.unitNumber && <p className="text-slate-600 dark:text-slate-400">{machine.name}</p>}
      </div>

      {checkedOut && !machine.current && (
        <p className="rounded-lg border border-emerald-300 bg-emerald-50 p-4 font-medium text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-300">
          ✓ You&apos;re checked out. Thanks!
        </p>
      )}

      {machine.lockedOut && (
        <p className="rounded-lg border-2 border-red-400 bg-red-50 p-4 font-medium text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          🔒 Locked out for repair. Do not operate this machine. A manager clears the lockout once it&apos;s repaired.
        </p>
      )}

      {machine.current && !machine.lockedOut && (
        <section className="space-y-3 rounded-lg border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900">
          <p>
            Checked in: <span className="font-semibold">{machine.current.operatorName}</span>
            <span className="text-slate-500"> since {clockTime(machine.current.startedAt, appTimeZone())}</span>
          </p>
          <details>
            <summary className="cursor-pointer text-sky-700 dark:text-sky-400">That&apos;s me: check out</summary>
            <div className="mt-3">
              <CheckOutForm machineCode={machine.code} />
            </div>
          </details>
        </section>
      )}

      {!machine.lockedOut && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{machine.current ? "Starting a shift? Check in" : "Check in"}</h2>
          <CheckInForm machineCode={machine.code} checklist={machine.checklist} />
        </section>
      )}
    </div>
  );
}
