"use client";

import { useActionState, useState } from "react";
import { machineLabel } from "@/lib/format";
import { addReadingAction, saveScheduleAction, type FormState } from "../actions";

const idle: FormState = { status: "idle" };
const field = "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-base sm:text-sm dark:border-slate-700 dark:bg-slate-900";

type MachineChoice = { id: number; name: string; unitNumber: string | null; onRoad: boolean };

export type ScheduleValues = {
  id: number | null;
  machineId: number | null;
  description: string;
  everyHours: number | null;
  everyKm: number | null;
  everyDays: number | null;
  active: boolean;
};

/** A service schedule: every so many hours, km, days or months (whichever comes first), and when it was last done. */
export function ScheduleForm({ schedule, machines }: { schedule: ScheduleValues; machines: MachineChoice[] }) {
  const [state, action, pending] = useActionState(saveScheduleAction, idle);
  const v = state.values;
  const months = schedule.everyDays && schedule.everyDays % 30 === 0 ? String(schedule.everyDays / 30) : "";
  const days = schedule.everyDays && !months ? String(schedule.everyDays) : "";
  const [machineId, setMachineId] = useState(v?.machineId ?? (schedule.machineId ? String(schedule.machineId) : ""));
  const onRoad = machines.find((m) => String(m.id) === machineId)?.onRoad ?? false;
  return (
    <form key={state.attempt} action={action} className="space-y-4">
      {schedule.id && <input type="hidden" name="scheduleId" value={schedule.id} />}
      <label className="block space-y-1">
        <span className="text-sm font-medium">Machine</span>
        <select name="machineId" required value={machineId} onChange={(e) => setMachineId(e.target.value)} className={field}>
          <option value="">Choose…</option>
          {machines.map((m) => (
            <option key={m.id} value={m.id}>
              {machineLabel(m)}
            </option>
          ))}
        </select>
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium">Service</span>
        <input name="description" required maxLength={120} defaultValue={v?.description ?? schedule.description} placeholder="e.g. 250-hour service, Annual inspection" className={field} />
      </label>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Every (fill in one or more: whichever comes first)</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <label className="space-y-1 text-sm">
            Hours
            <input name="everyHours" inputMode="decimal" defaultValue={v?.everyHours ?? schedule.everyHours ?? ""} placeholder="250" className={field} />
          </label>
          <label className="space-y-1 text-sm">
            Km
            <input name="everyKm" inputMode="decimal" defaultValue={v?.everyKm ?? schedule.everyKm ?? ""} placeholder={onRoad ? "10000" : ""} className={field} />
          </label>
          <label className="space-y-1 text-sm">
            Months
            <input name="everyMonths" inputMode="numeric" defaultValue={v?.everyMonths ?? months} placeholder="12" className={field} />
          </label>
          <label className="space-y-1 text-sm">
            or days
            <input name="everyDays" inputMode="numeric" defaultValue={v?.everyDays ?? days} className={field} />
          </label>
        </div>
      </fieldset>
      <fieldset className="space-y-2 rounded-lg border border-slate-200 p-3 dark:border-slate-800">
        <legend className="px-1 text-sm font-medium">Last done (optional)</legend>
        <p className="text-xs text-slate-500">
          {schedule.id
            ? "Only to restart the count. Otherwise the next due moves on each time its service item is resolved."
            : "The first one is due this far from the last service, or from today and the current reading if you leave these empty."}
        </p>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <label className="space-y-1 text-sm">
            Date
            <input type="date" name="lastDoneOn" defaultValue={v?.lastDoneOn} className={field} />
          </label>
          <label className="space-y-1 text-sm">
            At hours
            <input name="lastDoneHours" inputMode="decimal" defaultValue={v?.lastDoneHours} className={field} />
          </label>
          <label className="space-y-1 text-sm">
            At km
            <input name="lastDoneKm" inputMode="decimal" defaultValue={v?.lastDoneKm} className={field} />
          </label>
        </div>
      </fieldset>
      {schedule.id && (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="active" value="on" defaultChecked={schedule.active} />
          Active (untick to pause it)
        </label>
      )}
      {state.status === "error" && <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">{state.message}</p>}
      <button disabled={pending} className="min-h-11 w-full rounded-lg bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-50 sm:w-auto">
        {pending ? "Saving…" : "Save schedule"}
      </button>
    </form>
  );
}

/** Record an hour meter or odometer reading (a machine, or a choice of machines). */
export function ReadingForm({ machines, fixedMachine }: { machines?: MachineChoice[]; fixedMachine?: MachineChoice }) {
  const [state, action, pending] = useActionState(addReadingAction, idle);
  const [machineId, setMachineId] = useState(fixedMachine ? String(fixedMachine.id) : "");
  const chosen = fixedMachine ?? machines?.find((m) => String(m.id) === machineId);
  return (
    <form key={state.attempt} action={action} className="flex flex-wrap items-end gap-2 text-sm">
      {fixedMachine ? (
        <input type="hidden" name="machineId" value={fixedMachine.id} />
      ) : (
        <label className="space-y-1">
          <span className="block text-slate-500">Machine</span>
          <select name="machineId" required value={machineId} onChange={(e) => setMachineId(e.target.value)} className="rounded-lg border border-slate-300 bg-transparent px-2 py-2 dark:border-slate-700">
            <option value="">Choose…</option>
            {machines?.map((m) => (
              <option key={m.id} value={m.id}>
                {machineLabel(m)}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="space-y-1">
        <span className="block text-slate-500">Reading</span>
        <input name="reading" required inputMode="decimal" defaultValue={state.status === "error" ? state.values?.reading : ""} className="w-32 rounded-lg border border-slate-300 bg-transparent px-2 py-2 dark:border-slate-700" />
      </label>
      <select name="kind" defaultValue={state.values?.kind || (chosen?.onRoad ? "km" : "hours")} key={chosen?.id} aria-label="Unit" className="rounded-lg border border-slate-300 bg-transparent px-2 py-2 dark:border-slate-700">
        <option value="hours">hours</option>
        <option value="km">km</option>
      </select>
      <button disabled={pending} className="min-h-10 rounded-lg border border-slate-300 px-3 py-2 font-medium hover:bg-slate-50 disabled:opacity-50 dark:border-slate-700 dark:hover:bg-slate-800">
        {pending ? "Saving…" : "Save reading"}
      </button>
      {state.status === "error" && <span className="w-full text-red-700 dark:text-red-400">{state.message}</span>}
      {state.status === "saved" && <span className="w-full text-emerald-700 dark:text-emerald-400">✓ {state.message}</span>}
    </form>
  );
}
