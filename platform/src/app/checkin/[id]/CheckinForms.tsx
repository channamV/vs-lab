"use client";

import { startTransition, useActionState, useState, type FormEvent } from "react";
import type { AnswerOption, ChecklistSection } from "@/lib/db/schema";
import { formatDistance } from "@/lib/format";
import { checkInAction, checkOutAction, type CheckinFormState } from "./actions";
import { shrinkPhoto } from "@/lib/shrink-photo";

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

/** Asks the phone for its position. Resolves to null if the operator declines or it takes too long. */
function getPhoneLocation(): Promise<GeolocationPosition | null> {
  return new Promise((resolve) => {
    if (!("geolocation" in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), {
      enableHighAccuracy: true,
      timeout: 15_000,
      maximumAge: 60_000,
    });
  });
}

export type PublicChecklist = { sections: ChecklistSection[]; options: AnswerOption[]; confirmationText: string; photosEnabled: boolean };

const MAX_PHOTOS_PER_QUESTION = 3;

function PhotoPicker({
  required,
  photos,
  onChange,
  big,
}: {
  required: boolean;
  photos: { file: File; url: string }[];
  onChange: (photos: { file: File; url: string }[]) => void;
  big?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      {photos.map((p, i) => (
        <div key={p.url} className="relative">
          {/* eslint-disable-next-line @next/next/no-img-element -- a local preview, not a page image */}
          <img src={p.url} alt={`Photo ${i + 1}`} className="h-16 w-16 rounded object-cover" />
          <button
            type="button"
            onClick={() => onChange(photos.filter((_, n) => n !== i))}
            className="absolute -right-1.5 -top-1.5 h-6 w-6 rounded-full bg-slate-800 text-xs text-white"
            aria-label={`Remove photo ${i + 1}`}
          >
            ✕
          </button>
        </div>
      ))}
      {photos.length < MAX_PHOTOS_PER_QUESTION && (
        <label
          className={`flex cursor-pointer items-center gap-2 rounded border-2 border-dashed px-3 ${big ? "py-4 text-base" : "py-1.5 text-sm"} ${
            required && photos.length === 0 ? "border-sky-600 text-sky-700 dark:text-sky-400" : "border-slate-300 text-slate-600 dark:border-slate-700 dark:text-slate-400"
          }`}
        >
          📷 {busy ? "Preparing…" : photos.length ? "Add another" : required ? "Take photo (required)" : "Add photo"}
          <input
            type="file"
            accept="image/*"
            capture="environment"
            className="sr-only"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              setBusy(true);
              const small = await shrinkPhoto(file);
              setBusy(false);
              onChange([...photos, { file: small, url: URL.createObjectURL(small) }]);
            }}
          />
        </label>
      )}
    </div>
  );
}

/**
 * PIN, the machine's checklist, notes, then (after a major defect) whether to lock the machine out,
 * and the confirmation statement. Answers are React state, so nothing is lost if the server says no.
 */
export function CheckInForm({ machineCode, checklist }: { machineCode: string; checklist: PublicChecklist }) {
  const [state, action, pending] = useActionState(checkInAction, idle);
  const [locating, setLocating] = useState(false);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [generalNotes, setGeneralNotes] = useState("");
  const [lockout, setLockout] = useState<"yes" | "no" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [photos, setPhotos] = useState<Record<string, { file: File; url: string }[]>>({});
  const [photoError, setPhotoError] = useState<string | null>(null);

  // Get the phone's location first, then submit it with the form.
  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missing = checklist.photosEnabled
      ? checklist.sections.flatMap((s) => s.questions).filter((q) => (q.photoRequired || q.photoOnly) && !photos[q.id]?.length)
      : [];
    if (missing.length) {
      setPhotoError(`Take the required photo${missing.length > 1 ? "s" : ""}: ${missing.map((q) => q.text).join("; ")}`);
      return;
    }
    setPhotoError(null);
    const formData = new FormData(event.currentTarget);
    for (const [questionId, list] of Object.entries(photos)) {
      for (const p of list) formData.append(`photo:${questionId}`, p.file, p.file.name);
    }
    setLocating(true);
    const position = await getPhoneLocation();
    setLocating(false);
    if (position) {
      formData.set("phoneLat", String(position.coords.latitude));
      formData.set("phoneLng", String(position.coords.longitude));
      formData.set("phoneAccuracy", String(position.coords.accuracy));
    }
    startTransition(() => action(formData));
  }

  if (state.status === "locked-out") {
    return (
      <div className="space-y-2 rounded-lg border-2 border-red-400 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-xl font-semibold text-red-800 dark:text-red-300">🔒 Machine locked out for repair</p>
        <p className="text-red-800 dark:text-red-300">Do not operate it. Your supervisor has been told about:</p>
        <ul className="list-disc pl-5 text-red-800 dark:text-red-300">
          {state.failedItems.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <p className="text-sm text-slate-600 dark:text-slate-400">A manager clears the lockout once it&apos;s repaired.</p>
      </div>
    );
  }

  if (state.status === "checked-in") {
    return (
      <div className="space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 dark:border-emerald-800 dark:bg-emerald-950">
        <p className="text-xl font-semibold text-emerald-800 dark:text-emerald-300">✓ Checked in: {state.operatorName}</p>
        {state.location === "near" && (
          <p className="text-emerald-800 dark:text-emerald-300">📍 Location confirmed: you&apos;re at the machine.</p>
        )}
        {state.location === "far" && (
          <p className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            Your phone is {formatDistance(state.distanceM)} from this machine. Your check-in was recorded and flagged. Check in
            standing at the machine.
          </p>
        )}
        {state.location === "no-phone-location" && (
          <p className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            Your location wasn&apos;t shared, so we couldn&apos;t confirm you&apos;re at the machine. Your check-in was recorded
            and flagged. Next time, tap Allow when your phone asks.
          </p>
        )}
        {!state.authorized && (
          <p className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            You&apos;re not on the approved operator list for this machine. Your check-in was recorded. Talk to your
            supervisor before operating it.
          </p>
        )}
        {state.failedItems.length > 0 && (
          <div className="rounded bg-amber-100 px-3 py-2 text-amber-900 dark:bg-amber-900/50 dark:text-amber-200">
            <p className="font-medium">Defects reported (your supervisor has been told):</p>
            <ul className="mt-1 list-disc pl-5">
              {state.failedItems.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        <p className="font-medium">
          {state.engineRunning
            ? "The engine is running: you're now the operator."
            : `Start the engine within ${state.startWindowMinutes} minutes.`}
        </p>
        <p className="text-sm text-slate-600 dark:text-slate-400">
          You&apos;ll be checked out automatically when the engine stops. Scan again before the next start.
        </p>
      </div>
    );
  }

  const hasMajor = checklist.sections.some((s) =>
    s.questions.some((q) => checklist.options.find((o) => o.key === answers[q.id])?.severity === "major"),
  );
  const lockingOut = hasMajor && lockout === "yes";
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <input type="hidden" name="machineCode" value={machineCode} />
      <label className="block space-y-1">
        <span className="font-medium">1. Your PIN</span>
        <PinInput />
      </label>

      <fieldset className="space-y-3">
        <legend className="font-medium">2. Pre-start checklist</legend>
        {checklist.sections.map((section) => (
          <div key={section.id} className="space-y-2">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">{section.title}</h3>
            {section.questions.map((q) => {
              const chosen = checklist.options.find((o) => o.key === answers[q.id]);
              const defect = chosen?.severity === "minor" || chosen?.severity === "major";
              const picker = checklist.photosEnabled && (
                <PhotoPicker
                  required={Boolean(q.photoRequired || q.photoOnly)}
                  big={q.photoOnly}
                  photos={photos[q.id] ?? []}
                  onChange={(list) => {
                    setPhotos((all) => ({ ...all, [q.id]: list }));
                    setPhotoError(null);
                  }}
                />
              );
              if (q.textOnly) {
                return (
                  <div key={q.id} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    <label htmlFor={`text-${q.id}`} className="block">
                      {q.text}
                    </label>
                    <input
                      id={`text-${q.id}`}
                      name={`note:${q.id}`}
                      value={notes[q.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))}
                      required
                      maxLength={500}
                      className="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    />
                    {picker}
                  </div>
                );
              }
              if (q.photoOnly) {
                return (
                  <div key={q.id} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                    <p>{q.text}</p>
                    {picker}
                  </div>
                );
              }
              return (
                <div key={q.id} className="rounded-lg border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-900">
                  <p>{q.text}</p>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    {checklist.options.map((o) => (
                      <label
                        key={o.key}
                        className="flex cursor-pointer items-center justify-center gap-2 rounded border-2 border-slate-200 px-1 py-2 text-center text-sm dark:border-slate-700"
                        style={answers[q.id] === o.key ? { borderColor: o.color, backgroundColor: `${o.color}1a` } : undefined}
                      >
                        <input
                          type="radio"
                          name={`item:${q.id}`}
                          value={o.key}
                          required
                          checked={answers[q.id] === o.key}
                          onChange={() => setAnswers((a) => ({ ...a, [q.id]: o.key }))}
                          style={{ accentColor: o.color }}
                        />
                        {o.label}
                      </label>
                    ))}
                  </div>
                  {defect && (
                    <input
                      name={`note:${q.id}`}
                      value={notes[q.id] ?? ""}
                      onChange={(e) => setNotes((n) => ({ ...n, [q.id]: e.target.value }))}
                      required={q.noteRequired}
                      maxLength={500}
                      placeholder={q.noteRequired ? "Describe the problem (required)" : "Describe the problem (optional)"}
                      className="mt-2 w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
                    />
                  )}
                  {picker}
                </div>
              );
            })}
          </div>
        ))}
      </fieldset>

      <label className="block space-y-1">
        <span className="font-medium">3. Notes (optional)</span>
        <textarea
          name="notes"
          rows={2}
          maxLength={1000}
          value={generalNotes}
          onChange={(e) => setGeneralNotes(e.target.value)}
          placeholder="Anything else your supervisor should know"
          className="w-full rounded border border-slate-300 bg-white px-3 py-2 dark:border-slate-700 dark:bg-slate-900"
        />
      </label>

      {hasMajor && (
        <fieldset className="space-y-2 rounded-lg border-2 border-red-300 bg-red-50 p-3 dark:border-red-800 dark:bg-red-950">
          <legend className="sr-only">Lock out</legend>
          <p className="font-medium text-red-800 dark:text-red-300">
            You indicated a major defect. Should we lock out this machine for repair?
          </p>
          <label className="flex items-center gap-2">
            <input type="radio" name="lockout" value="yes" required checked={lockout === "yes"} onChange={() => setLockout("yes")} />
            Yes, lock it out: nobody should operate it until it&apos;s repaired
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="lockout" value="no" checked={lockout === "no"} onChange={() => setLockout("no")} />
            No, it&apos;s safe to operate
          </label>
        </fieldset>
      )}

      {!lockingOut && (
        <label className="flex items-start gap-3 rounded-lg border border-slate-300 bg-white p-3 dark:border-slate-700 dark:bg-slate-900">
          <input
            type="checkbox"
            name="confirmed"
            required
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
            className="mt-1 h-5 w-5"
          />
          <span className="font-medium">{checklist.confirmationText}</span>
        </label>
      )}

      {photoError && <p className="rounded bg-red-50 px-3 py-2 text-red-700 dark:bg-red-950 dark:text-red-300">{photoError}</p>}
      <ErrorMessage state={state} />
      <button disabled={pending || locating} className={lockingOut ? `${buttonClass} bg-red-700 hover:bg-red-800` : buttonClass}>
        {locating ? "Getting your location…" : pending ? "Sending…" : lockingOut ? "Lock out machine" : "Check in"}
      </button>
      <p className="text-center text-sm text-slate-500">
        Your phone will ask to share your location. This confirms you&apos;re at the machine.
      </p>
    </form>
  );
}

export function CheckOutForm({ machineCode }: { machineCode: string }) {
  const [state, action, pending] = useActionState(checkOutAction, idle);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="machineCode" value={machineCode} />
      <PinInput />
      <ErrorMessage state={state} />
      <button disabled={pending} className="w-full rounded border border-slate-400 px-4 py-2.5 font-medium disabled:opacity-60">
        {pending ? "Checking out…" : "Check out"}
      </button>
    </form>
  );
}
