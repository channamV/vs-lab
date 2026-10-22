"use client";

import { useActionState } from "react";
import type { Machine } from "@/lib/db/schema";
import { TIER_LABELS } from "@/lib/format";
import {
  addMachineAction,
  pairDeviceAction,
  updateMachineAction,
  type MachineFields,
  type MachineFormState,
  type PairingState,
} from "./actions";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const button = "rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";

type Values = Partial<MachineFields>;
/** The divisions the user may choose from, and whether "No division" is allowed (whole-organization users). */
export type DivisionChoice = { divisions: { id: number; name: string }[]; allowNone: boolean };

function fromMachine(m: Machine): Values {
  return {
    name: m.name,
    unitNumber: m.unitNumber ?? "",
    machineType: m.machineType ?? "",
    make: m.make ?? "",
    model: m.model ?? "",
    year: m.year?.toString() ?? "",
    serialNumber: m.serialNumber ?? "",
    fuelTankLitres: m.fuelTankLitres?.toString() ?? "",
    speedLimitKph: m.speedLimitKph?.toString() ?? "",
    tier: m.tier,
    divisionId: m.divisionId?.toString() ?? "",
  };
}

function Fields({ values, choice }: { values: Values; choice: DivisionChoice }) {
  const text = (name: keyof MachineFields, label: string, props: React.InputHTMLAttributes<HTMLInputElement> = {}) => (
    <label className="block text-sm">
      <span className="text-slate-600 dark:text-slate-400">{label}</span>
      <input name={name} defaultValue={values[name] ?? ""} className={field} {...props} />
    </label>
  );
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {text("unitNumber", "Unit / fleet #", { maxLength: 20, placeholder: "e.g. 14" })}
      {text("name", "Name", { required: true, maxLength: 80, placeholder: "e.g. CAT 320 Excavator" })}
      {text("machineType", "Type", { maxLength: 40, placeholder: "e.g. Excavator" })}
      {text("make", "Make", { maxLength: 40, placeholder: "e.g. Caterpillar" })}
      {text("model", "Model", { maxLength: 40, placeholder: "e.g. 320" })}
      {text("year", "Year", { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 })}
      {text("serialNumber", "Serial # / VIN", { maxLength: 40 })}
      {text("fuelTankLitres", "Fuel tank size, litres (optional)", { inputMode: "decimal", maxLength: 8, placeholder: "e.g. 400" })}
      {text("speedLimitKph", "Top speed, km/h (optional; replaces the fleet speed limit)", { inputMode: "decimal", maxLength: 8, placeholder: "e.g. 25" })}
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Service level</span>
        <select name="tier" defaultValue={values.tier || "gps"} className={field}>
          {(["gps", "monitor", "control"] as const).map((t) => (
            <option key={t} value={t} disabled={t === "control"}>
              {TIER_LABELS[t]}
              {t === "control" ? " (future)" : ""}
            </option>
          ))}
        </select>
      </label>
      {choice.divisions.length > 0 && (
        <label className="block text-sm">
          <span className="text-slate-600 dark:text-slate-400">Division</span>
          <select name="divisionId" defaultValue={values.divisionId ?? ""} required={!choice.allowNone} className={field}>
            {choice.allowNone ? <option value="">No division</option> : <option value="" disabled>Choose…</option>}
            {choice.divisions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function AddMachineForm({ choice }: { choice: DivisionChoice }) {
  const [state, action, pending] = useActionState(addMachineAction, { error: null, version: 0 } as MachineFormState);
  return (
    <form key={state.version} action={action} className="space-y-3">
      <Fields values={state.values ?? {}} choice={choice} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Adding…" : "Add machine"}
      </button>
    </form>
  );
}

export function EditMachineForm({ machine, choice }: { machine: Machine; choice: DivisionChoice }) {
  const [state, action, pending] = useActionState(updateMachineAction, { error: null, version: 0 } as MachineFormState);
  return (
    <form key={state.version} action={action} className="space-y-3">
      <input type="hidden" name="id" value={machine.id} />
      <Fields values={state.values ?? fromMachine(machine)} choice={choice} />
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <button disabled={pending} className={button}>
        {pending ? "Saving…" : "Save"}
      </button>
    </form>
  );
}

/** Staff only: choose a device to put on this machine. */
export function PairDeviceForm({ machineId, devices }: { machineId: number; devices: { id: string; note: string }[] }) {
  const [state, action, pending] = useActionState(pairDeviceAction, { error: null, version: 0 } as PairingState);
  if (devices.length === 0) {
    return <p className="text-sm text-slate-500">No unpaired devices in Veristart&apos;s or this customer&apos;s stock.</p>;
  }
  return (
    <form key={state.version} action={action} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="machineId" value={machineId} />
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Pair a device</span>
        <select name="deviceId" required className={field}>
          {devices.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} ({d.note})
            </option>
          ))}
        </select>
      </label>
      <button disabled={pending} className={button}>
        {pending ? "Pairing…" : "Pair"}
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
