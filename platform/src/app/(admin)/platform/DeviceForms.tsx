"use client";

import { useActionState } from "react";
import { pairDeviceAction, type PairingState } from "../machines/actions";
import { setDeviceStockAction, type PlatformFormState } from "./actions";

const select = "rounded border border-slate-300 bg-transparent px-2 py-1 dark:border-slate-700";
const button = "rounded border border-slate-300 px-2 py-1 hover:bg-slate-50 disabled:opacity-60 dark:border-slate-700 dark:hover:bg-slate-800";

/** Put this device on a machine that has none. */
export function PairWithMachineForm({ deviceId, machines }: { deviceId: string; machines: { id: number; label: string }[] }) {
  const [state, action, pending] = useActionState(pairDeviceAction, { error: null, version: 0 } as PairingState);
  if (machines.length === 0) return <span className="text-xs text-slate-500">No machine without a device to pair with.</span>;
  return (
    <form key={state.version} action={action} className="flex flex-wrap gap-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      <select name="machineId" required className={select}>
        {machines.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
          </option>
        ))}
      </select>
      <button disabled={pending} className={button}>
        Pair
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}

/** Move an unpaired device between Veristart's stock and a customer's spares. */
export function DeviceStockForm({
  deviceId,
  current,
  organizations,
}: {
  deviceId: string;
  current: number | null;
  organizations: { id: number; name: string }[];
}) {
  const [state, action, pending] = useActionState(setDeviceStockAction, { error: null, version: 0 } as PlatformFormState);
  return (
    // key: rebuild after a save so the dropdown shows the saved stock
    <form key={`${state.version}:${current}`} action={action} className="flex flex-wrap gap-2">
      <input type="hidden" name="deviceId" value={deviceId} />
      <select name="organizationId" defaultValue={current ?? ""} className={select}>
        <option value="">Veristart stock</option>
        {organizations.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name} (spare)
          </option>
        ))}
      </select>
      <button disabled={pending} className={button}>
        Move
      </button>
      {state.error && <p className="w-full text-sm text-red-600">{state.error}</p>}
    </form>
  );
}
