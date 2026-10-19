"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import { saveRuleAction, type RuleFormState } from "./actions";

/**
 * New / edit subscription, laid out like the production portal's: name, event types, machines and
 * operators (empty = all), schedule, delivery. All fields are React state, so nothing is lost when
 * the server returns an error.
 */

type Option = { id: number; label: string; hint?: string };
export type RuleValues = {
  name: string;
  eventTypes: string[];
  machineIds: number[];
  divisionIds: number[];
  operatorIds: number[];
  weekdays: number[];
  startTime: string;
  endTime: string;
};

const card = "space-y-3 rounded-xl border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900";
const field = "w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700";
const chip = (on: boolean, disabled = false) =>
  `rounded-full border px-3 py-1 text-sm ${
    disabled
      ? "cursor-not-allowed border-dashed border-slate-300 text-slate-400 dark:border-slate-700 dark:text-slate-600"
      : on
        ? "border-sky-700 bg-sky-700 text-white"
        : "border-slate-400 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"
  }`;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const toggle = <T,>(list: T[], value: T) => (list.includes(value) ? list.filter((v) => v !== value) : [...list, value]);

function Picker({
  title,
  hint,
  name,
  options,
  selected,
  onChange,
}: {
  title: string;
  hint: string;
  name: string;
  options: Option[];
  selected: number[];
  onChange: (ids: number[]) => void;
}) {
  const [search, setSearch] = useState("");
  const shown = options.filter((o) => `${o.label} ${o.hint ?? ""}`.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className={card}>
      <div>
        <h2 className="font-semibold">{title}</h2>
        <p className="text-xs text-slate-500">
          {hint} · {selected.length ? `${selected.length} selected` : `${options.length} available`}
        </p>
      </div>
      {selected.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={`Search ${title.toLowerCase()}`}
        className={field}
        aria-label={`Search ${title.toLowerCase()}`}
      />
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {shown.length === 0 && <p className="text-sm text-slate-500">No {title.toLowerCase()} found.</p>}
        {shown.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onChange(toggle(selected, o.id))} />
            {o.label}
            {o.hint && <span className="text-xs text-slate-500">{o.hint}</span>}
          </label>
        ))}
      </div>
      {selected.length > 0 && (
        <button type="button" onClick={() => onChange([])} className="text-xs text-sky-700 hover:underline dark:text-sky-400">
          Clear (all {title.toLowerCase()})
        </button>
      )}
    </div>
  );
}

export function SubscriptionForm({
  userId,
  ruleId,
  initial,
  eventTypes,
  laterEventTypes,
  machines,
  divisions,
  operators,
  timeZone,
  email,
  cancelHref,
}: {
  userId: number;
  ruleId: number | null;
  initial: RuleValues;
  eventTypes: { value: string; label: string; description: string }[];
  laterEventTypes: string[];
  machines: Option[];
  divisions: Option[];
  operators: Option[];
  timeZone: string;
  email: string;
  cancelHref: string;
}) {
  const [state, action, pending] = useActionState(saveRuleAction, { error: null, version: 0 } as RuleFormState);
  const [v, setV] = useState(initial);
  const set = <K extends keyof RuleValues>(key: K, value: RuleValues[K]) => setV((prev) => ({ ...prev, [key]: value }));
  const selectedEvents = eventTypes.filter((e) => v.eventTypes.includes(e.value));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="ruleId" value={ruleId ?? ""} />

      <div className={card}>
        <label className="block space-y-2">
          <span className="font-semibold">Subscription name</span>
          <input
            name="name"
            value={v.name}
            onChange={(e) => set("name", e.target.value)}
            required
            maxLength={80}
            placeholder="e.g. Weekend machine starts"
            className={field}
          />
        </label>
      </div>

      <div className={card}>
        <h2 className="font-semibold">Event types</h2>
        {v.eventTypes.map((t) => (
          <input key={t} type="hidden" name="eventType" value={t} />
        ))}
        <div className="flex flex-wrap gap-2">
          {eventTypes.map((e) => (
            <button
              key={e.value}
              type="button"
              title={e.description}
              aria-pressed={v.eventTypes.includes(e.value)}
              onClick={() => set("eventTypes", toggle(v.eventTypes, e.value))}
              className={chip(v.eventTypes.includes(e.value))}
            >
              {e.label}
            </button>
          ))}
          {laterEventTypes.map((label) => (
            <span key={label} title="Not available in VS Lab yet" className={chip(false, true)}>
              {label}
            </span>
          ))}
        </div>
        {selectedEvents.length > 0 && (
          <ul className="space-y-0.5 text-xs text-slate-500">
            {selectedEvents.map((e) => (
              <li key={e.value}>
                <span className="font-medium text-slate-600 dark:text-slate-400">{e.label}:</span> {e.description}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-4">
          <Picker
            title="Machines"
            hint="Leave empty for all machines"
            name="machine"
            options={machines}
            selected={v.machineIds}
            onChange={(ids) => set("machineIds", ids)}
          />
          {divisions.length > 0 && (
            <div className={card}>
              <div>
                <h2 className="font-semibold">Divisions</h2>
                <p className="text-xs text-slate-500">Every machine in these divisions, as well as any machines ticked above.</p>
              </div>
              {v.divisionIds.map((id) => (
                <input key={id} type="hidden" name="division" value={id} />
              ))}
              <div className="flex flex-wrap gap-2">
                {divisions.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    aria-pressed={v.divisionIds.includes(d.id)}
                    onClick={() => set("divisionIds", toggle(v.divisionIds, d.id))}
                    className={chip(v.divisionIds.includes(d.id))}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
        <Picker
          title="Operators"
          hint="Leave empty for all operators"
          name="operator"
          options={operators}
          selected={v.operatorIds}
          onChange={(ids) => set("operatorIds", ids)}
        />
      </div>
      {v.operatorIds.length > 0 && (
        <p className="-mt-2 text-xs text-amber-700 dark:text-amber-400">
          With operators selected, events with no operator (e.g. Start Without Checklist, Equipment Updated) won&apos;t match.
        </p>
      )}

      <div className={card}>
        <h2 className="font-semibold">
          Schedule <span className="font-normal text-slate-500">(empty means any time)</span>
        </h2>
        {v.weekdays.map((d) => (
          <input key={d} type="hidden" name="weekday" value={d} />
        ))}
        <div className="flex flex-wrap gap-2">
          {DAYS.map((label, day) => (
            <button
              key={label}
              type="button"
              aria-pressed={v.weekdays.includes(day)}
              onClick={() => set("weekdays", toggle(v.weekdays, day))}
              className={chip(v.weekdays.includes(day))}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <label className="flex items-center gap-2">
            From
            <input type="time" name="startTime" value={v.startTime} onChange={(e) => set("startTime", e.target.value)} className="rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700" />
          </label>
          <label className="flex items-center gap-2">
            To
            <input type="time" name="endTime" value={v.endTime} onChange={(e) => set("endTime", e.target.value)} className="rounded-lg border border-slate-300 bg-transparent px-2 py-1.5 dark:border-slate-700" />
          </label>
          {(v.startTime || v.endTime) && (
            <button
              type="button"
              onClick={() => setV((prev) => ({ ...prev, startTime: "", endTime: "" }))}
              className="text-xs text-sky-700 hover:underline dark:text-sky-400"
            >
              Clear times
            </button>
          )}
        </div>
        <p className="text-xs text-slate-500">
          Times are {timeZone}. A window that ends before it starts runs overnight (e.g. 18:00 to 06:00, for after-hours
          starts).
        </p>
      </div>

      <div className={card}>
        <h2 className="font-semibold">Delivery</h2>
        <div className="space-y-2 rounded-lg border border-slate-300 p-3 dark:border-slate-700">
          <label className="flex items-center gap-2">
            <input type="checkbox" checked readOnly disabled /> Email
          </label>
          <input value={email} readOnly disabled className={`${field} text-slate-500`} aria-label="Email address" />
          <p className="text-xs text-slate-500">Sent to the sign-in address. Text messages may come later.</p>
        </div>
      </div>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex justify-end gap-3">
        <Link href={cancelHref} className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          Cancel
        </Link>
        <button
          disabled={pending || !v.name.trim() || v.eventTypes.length === 0}
          className="rounded-lg bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-50"
        >
          {pending ? "Saving…" : "Save subscription"}
        </button>
      </div>
    </form>
  );
}
