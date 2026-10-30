"use client";

import { useActionState, useRef, useState } from "react";
import { ScanButton } from "@/components/ScanButton";
import { ON_ROAD_CATEGORIES } from "@/lib/road-limits";
import type { Machine } from "@/lib/db/schema";
import { TIER_LABELS } from "@/lib/format";
import {
  addMachineAction,
  pairDeviceAction,
  scanPlateAction,
  updateMachineAction,
  type MachineFields,
  type MachineFormState,
  type PairingState,
} from "./actions";
import { applySerialLookup, LookupNotes, SerialLookupButton, type LookupNote } from "./SerialLookup";

const field = "mt-1 w-full rounded border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700";
const button = "rounded bg-sky-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-800 disabled:opacity-60";

type Values = Partial<MachineFields>;
/**
 * The divisions the user may choose from, whether "No division" is allowed (whole-organization users), and the
 * machine categories (training coverage).
 */
export type DivisionChoice = {
  divisions: { id: number; name: string }[];
  allowNone: boolean;
  categories: { id: number; name: string }[];
  /** "Scan serial plate" is available (src/lib/scan.ts). */
  scan?: boolean;
  /**
   * Safety & Access Control can be chosen (Veristart staff: it needs the starter relay installed). Others see it, and keep
   * it on a machine that already has it, but can't switch to or from it.
   */
  controlAllowed?: boolean;
};

/**
 * Scan to fill: reads the serial plate, or a photo of the VIN, and fills the form for the manager to check. The server
 * checks the number in the same step (VIN decoded by NHTSA, equipment PIN maker). A decoded VIN leads: its make, model
 * and year go into empty fields and the photo's only fill what's left; otherwise the plate leads and the number check
 * points out disagreements.
 */
function PlateScan({ form }: { form: React.RefObject<HTMLFormElement | null> }) {
  const [notes, setNotes] = useState<LookupNote[]>([]);
  return (
    <div className="space-y-1 rounded border border-dashed border-slate-300 p-3 dark:border-slate-700">
      <ScanButton
        label="Scan serial plate or VIN"
        onScan={async (file) => {
          setNotes([]);
          const data = new FormData();
          data.set("file", file);
          const result = await scanPlateAction(data);
          if (!result.ok) return result.error;
          const el = (name: string) => {
            const e = form.current?.elements.namedItem(name);
            return e instanceof HTMLInputElement || e instanceof HTMLSelectElement ? e : null;
          };
          const set = (name: string, value: string | number | null, onlyIfEmpty: boolean) => {
            const e = el(name);
            if (e && value !== null && value !== "" && !(onlyIfEmpty && e.value.trim())) e.value = String(value);
          };
          const f = result.fields;
          const vinLeads = result.lookup?.kind === "vin";
          const next: LookupNote[] = [];
          if (vinLeads && form.current) next.push(...applySerialLookup(form.current, result.lookup!));
          set("make", f.make, vinLeads);
          set("model", f.model, vinLeads);
          set("year", f.year, vinLeads);
          if (!vinLeads) set("serialNumber", f.serialNumber, false);
          set("machineType", f.machineType, true);
          set("categoryId", result.categoryId, true);
          if (f.make) set("name", [f.make, f.model, f.machineType].filter(Boolean).join(" "), true);
          if (!vinLeads && result.lookup && form.current) next.push(...applySerialLookup(form.current, result.lookup));
          if (!f.serialNumber) next.push({ tone: "info", text: "No serial number or VIN was readable in the photo." });
          setNotes(next);
          return null;
        }}
      />
      <p className="text-xs text-slate-500">
        Take a photo of the machine&apos;s ID plate, or of its VIN (dashboard, door-jamb sticker or registration). Make, model, year
        and serial number are filled in for you to check; a VIN is decoded with NHTSA&apos;s records. The photo isn&apos;t kept.
      </p>
      <LookupNotes notes={notes} />
    </div>
  );
}

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
    categoryId: m.categoryId?.toString() ?? "",
    onRoad: m.onRoad ? "on" : "",
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
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Category (which training covers it)</span>
        <select
          name="categoryId"
          defaultValue={values.categoryId ?? ""}
          className={field}
          onChange={(e) => {
            // Pickups and on-road dump trucks drive on public roads.
            const name = e.currentTarget.selectedOptions[0]?.textContent ?? "";
            const box = e.currentTarget.form?.elements.namedItem("onRoad");
            if (box instanceof HTMLInputElement && ON_ROAD_CATEGORIES.includes(name)) box.checked = true;
          }}
        >
          <option value="">No category</option>
          {choice.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {text("make", "Make", { maxLength: 40, placeholder: "e.g. Caterpillar" })}
      {text("model", "Model", { maxLength: 40, placeholder: "e.g. 320" })}
      {text("year", "Year", { inputMode: "numeric", pattern: "[0-9]{4}", maxLength: 4 })}
      {text("serialNumber", "Serial # / VIN", { maxLength: 40 })}
      <SerialLookupButton />
      <label className="flex items-start gap-2 text-sm sm:col-span-2">
        <input type="checkbox" name="onRoad" defaultChecked={values.onRoad === "on"} className="mt-1" />
        <span>
          On-road vehicle
          <span className="block text-xs text-slate-500">Drives on public roads: checked against posted speed limits (Settings → Safety rules).</span>
        </span>
      </label>
      {text("fuelTankLitres", "Fuel tank size, litres (optional)", { inputMode: "decimal", maxLength: 8, placeholder: "e.g. 400" })}
      {text("speedLimitKph", "Top speed, km/h (optional; replaces the fleet speed limit)", { inputMode: "decimal", maxLength: 8, placeholder: "e.g. 25" })}
      <label className="block text-sm">
        <span className="text-slate-600 dark:text-slate-400">Service level</span>
        <select name="tier" defaultValue={values.tier || "gps"} className={field}>
          {(["gps", "monitor", "control"] as const).map((t) => {
            const locked = !choice.controlAllowed && (t === "control") !== (values.tier === "control");
            return (
              <option key={t} value={t} disabled={locked}>
                {TIER_LABELS[t]}
                {t === "control" ? (choice.controlAllowed ? " (needs the starter relay installed)" : " (set up by Veristart)") : ""}
              </option>
            );
          })}
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
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} key={state.version} action={action} className="space-y-3">
      {choice.scan && <PlateScan form={form} />}
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
  const form = useRef<HTMLFormElement>(null);
  return (
    <form ref={form} key={state.version} action={action} className="space-y-3">
      <input type="hidden" name="id" value={machine.id} />
      {choice.scan && <PlateScan form={form} />}
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
