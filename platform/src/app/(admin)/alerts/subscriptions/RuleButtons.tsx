"use client";

import { deleteRuleAction, setRuleEnabledAction } from "./actions";

/** On/off switch for a subscription (pauses it without deleting it). */
export function EnabledSwitch({ userId, ruleId, enabled }: { userId: number; ruleId: number; enabled: boolean }) {
  return (
    <form action={setRuleEnabledAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="ruleId" value={ruleId} />
      <input type="hidden" name="enabled" value={String(!enabled)} />
      <button
        role="switch"
        aria-checked={enabled}
        aria-label={enabled ? "On: click to pause" : "Paused: click to turn on"}
        className={`relative h-6 w-11 rounded-full transition ${enabled ? "bg-sky-700" : "bg-slate-300 dark:bg-slate-700"}`}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition ${enabled ? "left-5" : "left-0.5"}`} />
      </button>
    </form>
  );
}

export function DeleteRuleButton({ userId, ruleId, name }: { userId: number; ruleId: number; name: string }) {
  return (
    <form
      action={deleteRuleAction}
      onSubmit={(e) => {
        if (!confirm(`Delete the subscription "${name}"?`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="ruleId" value={ruleId} />
      <button className="text-sm text-red-700 hover:underline dark:text-red-400">Delete</button>
    </form>
  );
}
