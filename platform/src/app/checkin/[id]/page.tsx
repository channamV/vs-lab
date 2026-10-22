import { Suspense } from "react";
import { getCheckinMachine } from "@/lib/checkin-page";
import { appTimeZone } from "@/lib/telemetry/engine";
import { clockTime, periodText } from "@/lib/format";
import { VERISTART_PRIVACY } from "@/lib/privacy-limits";
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

      {machine.locked && (
        <p className="rounded-lg border-2 border-red-400 bg-red-50 p-4 font-medium text-red-800 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          🔒 This machine is Locked. Do not operate it. Ask your supervisor.
        </p>
      )}

      {machine.current && !machine.lockedOut && !machine.locked && (
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

      {!machine.lockedOut && !machine.locked && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{machine.current ? "Starting a shift? Check in" : "Check in"}</h2>
          <CheckInForm machineCode={machine.code} checklist={machine.checklist} />
        </section>
      )}

      {machine.privacy && <PrivacyNotice privacy={machine.privacy} />}
    </div>
  );
}

/** What's recorded about the operator, why, for how long, and who to ask (GDPR transparency). */
function PrivacyNotice({
  privacy,
}: {
  privacy: { name: string; privacyContact: string | null; locationDays: number; photoDays: number; checkinDays: number };
}) {
  return (
    <details className="rounded-lg border border-slate-200 p-3 text-sm text-slate-600 dark:border-slate-800 dark:text-slate-400">
      <summary className="cursor-pointer">Privacy: what this check-in records</summary>
      <div className="mt-2 space-y-2">
        <p>
          {privacy.name} records who operates its equipment, for safety, security and inspection records: your name, the
          time, your checklist answers, notes and photos, and when the machine was running. If you allow it, your
          phone&apos;s location at check-in is used to confirm you&apos;re at the machine.
        </p>
        <p>
          While you&apos;re checked in, the machine&apos;s safety records are linked to you: hours operated and breaks (for
          fatigue limits), speeding, long idling, and entering restricted areas.
        </p>
        <p>
          Phone location is kept for {periodText(privacy.locationDays)}, photos for {periodText(privacy.photoDays)}, and
          check-in records for {periodText(privacy.checkinDays)}. The system is run for {privacy.name} by Veristart.
        </p>
        <p>
          To see the data held about you, or to ask for it to be corrected or erased,{" "}
          {privacy.privacyContact ? (
            <>
              contact <span className="font-medium">{privacy.privacyContact}</span>.
            </>
          ) : (
            <>ask your supervisor.</>
          )}
        </p>
        <p>
          How Veristart handles personal information:{" "}
          <a href={VERISTART_PRIVACY.policyUrl} className="underline" target="_blank" rel="noreferrer">
            Veristart privacy policy
          </a>
          . Veristart&apos;s Privacy Officer:{" "}
          <a href={`mailto:${VERISTART_PRIVACY.officerEmail}`} className="underline">
            {VERISTART_PRIVACY.officerEmail}
          </a>
          .
        </p>
      </div>
    </details>
  );
}
