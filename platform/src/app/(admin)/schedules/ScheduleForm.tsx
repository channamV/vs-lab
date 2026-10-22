"use client";

import Link from "next/link";
import { useActionState, useMemo, useState } from "react";
import { MODES, type Mode } from "@/lib/mode-types";
import {
  addDays,
  DAYS,
  describeSchedule,
  findConflicts,
  fmtInstant,
  occurrences,
  RECURRENCE_LABEL,
  timeIn,
  todayIn,
  TIMEZONES,
  tzName,
  tzOffsetLabel,
  tzShort,
  validateSchedule,
  zonedToUtc,
  type ConflictRule,
  type ConflictSeverity,
  type Recurrence,
  type ScheduleSpec,
} from "@/lib/schedule-time";
import { saveScheduleAction, type ScheduleFormState } from "./actions";

/**
 * New / edit schedule (Jira V1-267), laid out like the Notifications form: name and status, action, machines and
 * operators, timing (one-time, weekly or temporary override, in a visible timezone), what happens at the end, and a
 * plain-English preview with the next windows and any conflicts. Nothing is saved until "Save schedule".
 */

type Option = { id: number; label: string; hint?: string };
export type ScheduleFormData = {
  machines: (Option & { mode: Mode })[];
  machineNames: Option[];
  operators: Option[];
  others: ScheduleSpec[];
  actions: ("machine_mode" | "operator_access")[];
  wholeOrganization: boolean;
  fleetTimezone: string;
  conflictRule: ConflictRule;
};

type Draft = ScheduleSpec & { overrideStart: "now" | "later"; overrideDuration: "1h" | "2h" | "4h" | "8h" | "eod" | "custom" };
const DURATIONS = [
  { value: "1h", label: "1 hour", minutes: 60 },
  { value: "2h", label: "2 hours", minutes: 120 },
  { value: "4h", label: "4 hours", minutes: 240 },
  { value: "8h", label: "8 hours", minutes: 480 },
  { value: "eod", label: "Until end of day" },
  { value: "custom", label: "Custom" },
] as const;

const card = "space-y-3 rounded-xl border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900";
const field = "rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700";
const chip = (on: boolean) =>
  `rounded-full border px-3 py-1 text-sm ${on ? "border-sky-700 bg-sky-700 text-white" : "border-slate-400 text-slate-700 hover:bg-slate-50 dark:border-slate-600 dark:text-slate-300 dark:hover:bg-slate-800"}`;
const SEVERITY: Record<ConflictSeverity, { label: string; box: string }> = {
  conflict: { label: "Conflict", box: "border-red-300 bg-red-50 dark:border-red-900 dark:bg-red-950/40" },
  warning: { label: "Heads up", box: "border-amber-300 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40" },
  overlap: { label: "Overlap", box: "border-amber-200 bg-amber-50/60 dark:border-amber-900 dark:bg-amber-950/20" },
  info: { label: "Priority", box: "border-sky-200 bg-sky-50 dark:border-sky-900 dark:bg-sky-950/40" },
};
const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

function blank(tz: string, action: Draft["action"]): Draft {
  const today = todayIn(tz);
  return {
    name: "",
    status: "active",
    action,
    mode: null,
    machineIds: [],
    operatorIds: [],
    recurrence: "weekly",
    timezone: tz,
    startDate: today,
    startTime: "18:00",
    endDate: addDays(today, 1),
    endTime: "06:00",
    noEnd: false,
    weekdays: [],
    allDay: false,
    effectiveFrom: today,
    effectiveUntil: null,
    endBehavior: "revert",
    endMode: null,
    remindBeforeExpiry: true,
    overrideStart: "now",
    overrideDuration: "4h",
  };
}

/** Form state → the schedule that would be saved (e.g. "start now + 4 hours" becomes dates and times). */
function resolve(d: Draft, now: number): ScheduleSpec {
  const { overrideStart, overrideDuration, ...s } = d;
  if (s.recurrence === "weekly") return { ...s, startDate: null, endDate: null, noEnd: false, startTime: s.allDay ? null : s.startTime, endTime: s.allDay ? null : s.endTime };
  if (s.recurrence === "once") return { ...s, allDay: false, weekdays: [], effectiveFrom: null, effectiveUntil: null, ...(s.noEnd && { endDate: null, endTime: null }) };
  const tz = s.timezone;
  const startDate = overrideStart === "now" ? todayIn(tz, now) : s.startDate;
  const startTime = overrideStart === "now" ? timeIn(tz, now) : s.startTime;
  let endDate = s.endDate;
  let endTime = s.endTime;
  const preset = DURATIONS.find((x) => x.value === overrideDuration);
  if (startDate && startTime && preset && "minutes" in preset) {
    const end = zonedToUtc(startDate, startTime, tz) + preset.minutes * 60_000;
    endDate = todayIn(tz, end);
    endTime = timeIn(tz, end);
  } else if (startDate && overrideDuration === "eod") {
    endDate = startDate;
    endTime = "23:59";
  }
  return { ...s, allDay: false, weekdays: [], effectiveFrom: null, effectiveUntil: null, noEnd: false, startDate, startTime, endDate, endTime };
}

export function ScheduleForm({ data, initial, id, duplicate }: { data: ScheduleFormData; initial: ScheduleSpec | null; id?: number; duplicate?: boolean }) {
  const [state, action, pending] = useActionState(saveScheduleAction, { error: null, version: 0 } as ScheduleFormState);
  const [now] = useState(() => Date.now());
  const [d, setD] = useState<Draft>(() =>
    initial
      ? {
          ...blank(initial.timezone, initial.action as Draft["action"]),
          ...initial,
          name: duplicate ? `${initial.name} (copy)` : initial.name,
          status: duplicate ? "paused" : initial.status,
          startDate: initial.startDate ?? todayIn(initial.timezone),
          endDate: initial.endDate ?? todayIn(initial.timezone),
          overrideStart: "later",
          overrideDuration: "custom",
        }
      : blank(data.fleetTimezone, data.actions[0] ?? "machine_mode"),
  );
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((c) => ({ ...c, [k]: v }));
  const isMode = d.action === "machine_mode";

  const names = useMemo(
    () => ({
      machines: new Map(data.machineNames.map((m) => [m.id, m.label])),
      operators: new Map(data.operators.map((o) => [o.id, o.label])),
      allMachines: (data.wholeOrganization ? data.machineNames : data.machines).map((m) => m.id),
    }),
    [data],
  );
  const resolved = useMemo(() => resolve(d, now), [d, now]);
  const issues = useMemo(() => validateSchedule(resolved, now), [resolved, now]);
  const conflicts = useMemo(
    () => (issues.length ? [] : findConflicts({ ...resolved, id: id ?? -1 }, data.others, names, data.conflictRule, now)),
    [issues.length, resolved, id, data, names, now],
  );
  const upcoming = issues.length ? [] : occurrences(resolved, now).slice(0, 5);
  const description = issues.length ? [] : describeSchedule(resolved, names, now);
  const overnight = d.recurrence === "weekly" && !d.allDay && d.startTime && d.endTime && d.endTime < d.startTime;

  if (!data.actions.length) {
    return <p className={`${card} text-sm text-slate-500`}>You can&apos;t schedule changes: scheduling uses the same permissions as changing modes and operator approvals by hand (managers and owners).</p>;
  }
  return (
    <form
      action={(fd) => {
        fd.set("payload", JSON.stringify(Object.fromEntries(Object.entries(resolved).filter(([k]) => k !== "id"))));
        return action(fd);
      }}
      className="max-w-5xl space-y-5"
    >
      <input type="hidden" name="id" value={id ?? ""} />
      <section className={card}>
        <div className="flex items-center justify-between gap-4">
          <label htmlFor="schedule-name" className="font-semibold">
            Schedule name
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={d.status === "active"} onChange={(e) => set("status", e.target.checked ? "active" : "paused")} />
            {d.status === "active" ? "Active" : "Paused"}
          </label>
        </div>
        <input id="schedule-name" value={d.name} maxLength={80} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Weeknight lockdown" className={`${field} w-full`} />
      </section>

      <section className={card}>
        <h2 className="font-semibold">Action</h2>
        <div className="grid gap-3 md:grid-cols-2">
          {(
            [
              { value: "machine_mode", label: "🔒 Machine Mode", text: "Set selected machines to Access-Controlled, Unlocked or Locked." },
              { value: "operator_access", label: "🔑 Operator Access", text: "Give selected operators access to selected machines for a set period." },
            ] as const
          )
            .filter((a) => data.actions.includes(a.value))
            .map((a) => (
              <button
                type="button"
                key={a.value}
                onClick={() => set("action", a.value)}
                className={`rounded-lg border p-4 text-left ${d.action === a.value ? "border-sky-700 bg-sky-50 ring-1 ring-sky-700 dark:bg-sky-950/40" : "border-slate-300 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800"}`}
              >
                <span className="text-sm font-semibold">{a.label}</span>
                <span className="mt-1 block text-xs text-slate-500">{a.text}</span>
              </button>
            ))}
        </div>
        {isMode && (
          <div>
            <p className="text-sm text-slate-600 dark:text-slate-400">Set machines to</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(MODES) as Mode[]).map((m) => (
                <button type="button" key={m} onClick={() => set("mode", m)} className={chip(d.mode === m)}>
                  {MODES[m].label}
                </button>
              ))}
            </div>
            {d.mode && <p className="mt-2 text-xs text-slate-500">{MODES[d.mode as Mode].short} (GPS &amp; Telematics machines use Unlocked instead of Access-Controlled.)</p>}
          </div>
        )}
      </section>

      <div className="grid gap-5 md:grid-cols-2">
        <Picker
          title="Machines"
          hint={isMode ? (data.wholeOrganization ? "Leave empty for all machines" : "Choose from your divisions' machines") : "Required: the machines these operators can start"}
          options={data.machines.map((m) => ({ id: m.id, label: m.label, hint: `Now: ${MODES[m.mode].label}` }))}
          selected={d.machineIds}
          onChange={(ids) => set("machineIds", ids)}
        />
        {isMode ? (
          <section className={`${card} opacity-60`}>
            <h2 className="font-semibold">Operators</h2>
            <p className="text-sm text-slate-500">Not used for Machine Mode. Choose Operator Access to give operators access.</p>
          </section>
        ) : (
          <Picker title="Operators" hint="Required: who gets access during the window" options={data.operators} selected={d.operatorIds} onChange={(ids) => set("operatorIds", ids)} />
        )}
      </div>

      <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="font-semibold">Schedule</h2>
          <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
            🌐 Timezone
            <select value={d.timezone} onChange={(e) => set("timezone", e.target.value)} className={`${field} py-1`}>
              {[...TIMEZONES, ...(TIMEZONES.some((t) => t.value === d.timezone) ? [] : [{ value: d.timezone, label: d.timezone }])].map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label} ({tzShort(t.value, now)})
                </option>
              ))}
            </select>
          </label>
        </div>
        <p className="text-right text-xs text-slate-500">
          All times are {tzName(d.timezone)} time · now {fmtInstant(now, d.timezone, { hour: "numeric", minute: "2-digit" })} {tzShort(d.timezone, now)}
          {d.timezone === data.fleetTimezone && " · fleet default"}
        </p>
        <div className="flex flex-wrap gap-2">
          {(["once", "weekly", "override"] as Recurrence[]).map((r) => (
            <button type="button" key={r} onClick={() => set("recurrence", r)} className={chip(d.recurrence === r)}>
              {RECURRENCE_LABEL[r]}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-500">
          {d.recurrence === "once" && "Runs once, in a set window."}
          {d.recurrence === "weekly" && "Repeats every week on the chosen days."}
          {d.recurrence === "override" && "A temporary exception that takes priority over regular schedules for these machines, then ends."}
        </p>

        <div className="space-y-4 border-t border-slate-200 pt-4 text-sm dark:border-slate-800">
          {d.recurrence === "weekly" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                {DAYS.map((day, i) => (
                  <button type="button" key={day} onClick={() => set("weekdays", toggle(d.weekdays, i))} className={chip(d.weekdays.includes(i))}>
                    {day}
                  </button>
                ))}
                <span className="text-slate-400">|</span>
                <button type="button" onClick={() => set("weekdays", [1, 2, 3, 4, 5])} className="text-sky-700 hover:underline dark:text-sky-400">
                  Weekdays
                </button>
                <button type="button" onClick={() => set("weekdays", [0, 6])} className="text-sky-700 hover:underline dark:text-sky-400">
                  Weekends
                </button>
                <button type="button" onClick={() => set("weekdays", [0, 1, 2, 3, 4, 5, 6])} className="text-sky-700 hover:underline dark:text-sky-400">
                  Every day
                </button>
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label>
                  From <input type="time" value={d.startTime ?? ""} disabled={d.allDay} onChange={(e) => set("startTime", e.target.value)} className={field} />
                </label>
                <label>
                  To <input type="time" value={d.endTime ?? ""} disabled={d.allDay} onChange={(e) => set("endTime", e.target.value)} className={field} />
                </label>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={d.allDay} onChange={(e) => set("allDay", e.target.checked)} /> All day
                </label>
                {overnight && <span className="rounded bg-sky-50 px-2 py-1 text-xs text-sky-800 dark:bg-sky-950 dark:text-sky-300">🌙 Overnight: ends the next morning</span>}
              </div>
              <div className="flex flex-wrap items-center gap-4">
                <label>
                  Starting <input type="date" value={d.effectiveFrom ?? ""} onChange={(e) => set("effectiveFrom", e.target.value || null)} className={field} />
                </label>
                <label>
                  Ending <input type="date" value={d.effectiveUntil ?? ""} min={d.effectiveFrom ?? undefined} onChange={(e) => set("effectiveUntil", e.target.value || null)} className={field} />
                </label>
                {d.effectiveUntil ? (
                  <button type="button" onClick={() => set("effectiveUntil", null)} className="text-slate-500 hover:underline">
                    No end date
                  </button>
                ) : (
                  <span className="text-slate-500">No end date</span>
                )}
              </div>
            </>
          )}

          {d.recurrence === "once" && (
            <>
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-12 font-medium">Start</span>
                <input type="date" aria-label="Start date" value={d.startDate ?? ""} onChange={(e) => set("startDate", e.target.value)} className={field} />
                <input type="time" aria-label="Start time" value={d.startTime ?? ""} onChange={(e) => set("startTime", e.target.value)} className={field} />
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <span className="w-12 font-medium">End</span>
                <input type="date" aria-label="End date" value={d.endDate ?? ""} min={d.startDate ?? undefined} disabled={isMode && d.noEnd} onChange={(e) => set("endDate", e.target.value)} className={field} />
                <input type="time" aria-label="End time" value={d.endTime ?? ""} disabled={isMode && d.noEnd} onChange={(e) => set("endTime", e.target.value)} className={field} />
                {isMode && (
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={d.noEnd} onChange={(e) => set("noEnd", e.target.checked)} /> No end: keep this mode until changed by hand
                  </label>
                )}
              </div>
            </>
          )}

          {d.recurrence === "override" && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 font-medium">Starts</span>
                <button type="button" onClick={() => set("overrideStart", "now")} className={chip(d.overrideStart === "now")}>
                  Now
                </button>
                <button type="button" onClick={() => set("overrideStart", "later")} className={chip(d.overrideStart === "later")}>
                  At a set time
                </button>
                {d.overrideStart === "later" && (
                  <>
                    <input type="date" aria-label="Override start date" value={d.startDate ?? ""} onChange={(e) => set("startDate", e.target.value)} className={field} />
                    <input type="time" aria-label="Override start time" value={d.startTime ?? ""} onChange={(e) => set("startTime", e.target.value)} className={field} />
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="w-14 font-medium">Lasts</span>
                {DURATIONS.map((x) => (
                  <button type="button" key={x.value} onClick={() => set("overrideDuration", x.value)} className={chip(d.overrideDuration === x.value)}>
                    {x.label}
                  </button>
                ))}
                {d.overrideDuration === "custom" && (
                  <>
                    <span className="text-slate-500">until</span>
                    <input type="date" aria-label="Override end date" value={d.endDate ?? ""} onChange={(e) => set("endDate", e.target.value)} className={field} />
                    <input type="time" aria-label="Override end time" value={d.endTime ?? ""} onChange={(e) => set("endTime", e.target.value)} className={field} />
                  </>
                )}
              </div>
              {resolved.endDate && resolved.endTime && (
                <p className="text-slate-500">
                  Ends <b className="text-slate-900 dark:text-slate-100">{fmtInstant(zonedToUtc(resolved.endDate, resolved.endTime, d.timezone), d.timezone)}</b>{" "}
                  {tzShort(d.timezone, now)}
                </p>
              )}
            </>
          )}

          {!(d.recurrence === "once" && isMode && d.noEnd) && (
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950">
              <p className="font-medium">{d.recurrence === "override" ? "When the override ends" : "When the window ends"}</p>
              {isMode ? (
                <div className="mt-2 space-y-2">
                  <label className="flex items-start gap-2">
                    <input type="radio" name="end" checked={d.endBehavior === "revert"} onChange={() => set("endBehavior", "revert")} className="mt-1" />
                    <span>
                      {d.recurrence === "override" ? "Resume normal operation" : "Return to the previous mode"}
                      <span className="block text-xs text-slate-500">
                        Each machine goes back to the mode it had before, unless another schedule applies at that time.
                      </span>
                    </span>
                  </label>
                  <label className="flex flex-wrap items-center gap-2">
                    <input type="radio" name="end" checked={d.endBehavior === "set_mode"} onChange={() => set("endBehavior", "set_mode")} />
                    Set to a specific mode
                    {d.endBehavior === "set_mode" &&
                      (Object.keys(MODES) as Mode[])
                        .filter((m) => m !== d.mode)
                        .map((m) => (
                          <button type="button" key={m} onClick={() => set("endMode", m)} className={chip(d.endMode === m)}>
                            {MODES[m].label}
                          </button>
                        ))}
                  </label>
                </div>
              ) : (
                <p className="mt-1">
                  Access given by this schedule is removed.
                  <span className="block text-xs text-slate-500">Operators keep their permanent machine approvals.</span>
                </p>
              )}
              {d.recurrence === "override" && (
                <label className="mt-3 flex items-center gap-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                  <input type="checkbox" checked={d.remindBeforeExpiry} onChange={(e) => set("remindBeforeExpiry", e.target.checked)} />
                  Email me 15 minutes before the override ends
                </label>
              )}
            </div>
          )}
        </div>
      </section>

      <section className={card}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-semibold">Schedule preview</h2>
          <span className="text-xs text-slate-500">
            {tzName(d.timezone)} time · {tzOffsetLabel(d.timezone, now)}
          </span>
        </div>
        {issues.length > 0 ? (
          <div className="rounded-lg border border-dashed border-slate-300 p-4 text-sm dark:border-slate-700">
            <p className="font-medium text-slate-600 dark:text-slate-400">Finish these to see exactly what will happen:</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-slate-500">
              {issues.map((i) => (
                <li key={i}>{i}</li>
              ))}
            </ul>
          </div>
        ) : (
          <>
            <div className="space-y-2 rounded-lg border border-slate-200 p-4 text-sm dark:border-slate-800">
              {resolved.status === "paused" && <p className="rounded bg-slate-100 px-2 py-1 text-xs font-medium dark:bg-slate-800">Paused: nothing below happens until it&apos;s made active.</p>}
              {description.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </div>
            {upcoming.length > 0 && (
              <div>
                <p className="text-sm font-medium text-slate-600 dark:text-slate-400">{resolved.recurrence === "weekly" ? "Next windows" : "Window"}</p>
                <ul className="mt-2 divide-y divide-slate-200 rounded-lg border border-slate-200 text-sm dark:divide-slate-800 dark:border-slate-800">
                  {upcoming.map((o) => (
                    <li key={o.start} className="flex flex-wrap justify-between gap-2 px-4 py-2">
                      <span>
                        {fmtInstant(o.start, d.timezone)} → {o.end === null ? "until changed by hand" : fmtInstant(o.end, d.timezone)}{" "}
                        <span className="text-xs text-slate-500">{tzShort(d.timezone, o.start)}</span>
                      </span>
                      {o.start <= now && (o.end === null || o.end > now) && <span className="rounded-full bg-emerald-100 px-2 text-xs font-medium text-emerald-800">In effect now</span>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-slate-600 dark:text-slate-400">Conflicts &amp; overlaps</p>
              {conflicts.length === 0 ? (
                <p className="mt-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
                  ✓ No conflicts with your other active schedules.
                </p>
              ) : (
                <ul className="mt-2 space-y-2">
                  {conflicts.map((c) => (
                    <li key={`${c.otherId}-${c.severity}`} className={`rounded-lg border px-4 py-3 text-sm ${SEVERITY[c.severity].box}`}>
                      <p>
                        <span className="mr-2 rounded bg-white/70 px-1.5 text-xs font-semibold dark:bg-black/30">{SEVERITY[c.severity].label}</span>
                        <Link href={`/schedules/${c.otherId}`} className="font-medium hover:underline">
                          {c.otherName}
                        </Link>{" "}
                        <span className="text-xs text-slate-500">first overlap {fmtInstant(c.window.start, d.timezone)}</span>
                      </p>
                      <p className="mt-1">{c.message}</p>
                      {c.resolution && <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">{c.resolution}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </section>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex items-center justify-end gap-3">
        <Link href="/schedules" className="rounded-lg border border-slate-300 px-4 py-2 dark:border-slate-700">
          Cancel
        </Link>
        <button disabled={pending || issues.length > 0} className="rounded-lg bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-50">
          {pending ? "Saving…" : id ? "Save changes" : d.status === "active" ? "Save schedule" : "Save as paused"}
        </button>
      </div>
    </form>
  );
}

function Picker({ title, hint, options, selected, onChange }: { title: string; hint: string; options: Option[]; selected: number[]; onChange: (ids: number[]) => void }) {
  const [search, setSearch] = useState("");
  const shown = options.filter((o) => o.label.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <section className={card}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <h2 className="font-semibold">{title}</h2>
          <p className="text-xs text-slate-500">{hint}</p>
        </div>
        <span className="flex gap-2 text-xs">
          {selected.length > 0 && <span className="text-slate-500">{selected.length} selected</span>}
          {selected.length > 0 ? (
            <button type="button" onClick={() => onChange([])} className="text-sky-700 hover:underline dark:text-sky-400">
              Clear
            </button>
          ) : (
            <button type="button" onClick={() => onChange(options.map((o) => o.id))} className="text-sky-700 hover:underline dark:text-sky-400">
              Select all
            </button>
          )}
        </span>
      </div>
      <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={`Search ${title.toLowerCase()}`} aria-label={`Search ${title.toLowerCase()}`} className={`${field} w-full`} />
      <div className="max-h-56 space-y-1 overflow-y-auto">
        {shown.length === 0 && <p className="text-sm text-slate-500">No {title.toLowerCase()} found.</p>}
        {shown.map((o) => (
          <label key={o.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(o.id)} onChange={() => onChange(toggle(selected, o.id))} />
            {o.label}
            {o.hint && <span className="ml-auto text-xs text-slate-500">{o.hint}</span>}
          </label>
        ))}
      </div>
    </section>
  );
}
