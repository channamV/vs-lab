"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import type { AnswerOption, ChecklistSection, Severity } from "@/lib/db/schema";
import { saveAnswerSetAction, saveTemplateAction, type EditorState } from "./actions";

/**
 * Editors for checklist templates and answer sets. Everything is React state and sent as JSON, so
 * nothing is lost when the server reports a problem. Ids of existing questions and answers are kept,
 * so renaming a question doesn't break the stacking of repeat defect reports.
 */

const card = "space-y-3 rounded-xl border border-slate-300 bg-white p-5 dark:border-slate-700 dark:bg-slate-900";
const field = "w-full rounded-lg border border-slate-300 bg-transparent px-3 py-2 dark:border-slate-700";
const small = "rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-50 disabled:opacity-40 dark:border-slate-700 dark:hover:bg-slate-800";
const primary = "rounded-lg bg-sky-700 px-4 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-50";

function move<T>(list: T[], index: number, by: -1 | 1): T[] {
  const next = [...list];
  const target = index + by;
  if (target < 0 || target >= list.length) return list;
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}

function Reorder({ index, count, onMove, onRemove, label }: { index: number; count: number; onMove: (by: -1 | 1) => void; onRemove: () => void; label: string }) {
  return (
    <div className="flex shrink-0 gap-1">
      <button type="button" className={small} disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move ${label} up`}>
        ↑
      </button>
      <button type="button" className={small} disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move ${label} down`}>
        ↓
      </button>
      <button type="button" className={small} onClick={onRemove} aria-label={`Remove ${label}`}>
        ✕
      </button>
    </div>
  );
}

type EditableQuestion = { id?: string; text: string; noteRequired: boolean; photoRequired?: boolean; photoOnly?: boolean; textOnly?: boolean };
type EditableSection = { id?: string; title: string; questions: EditableQuestion[] };

/**
 * How a question is answered: an answer (photos optional), an answer plus a required photo, a photo alone, or a written
 * answer (e.g. odometer reading).
 */
const KINDS = [
  { value: "answer", label: "Answer (photo optional)" },
  { value: "answer+photo", label: "Answer + required photo" },
  { value: "photo", label: "Photo only" },
  { value: "text", label: "Written answer" },
] as const;
const kindOf = (q: EditableQuestion) => (q.photoOnly ? "photo" : q.textOnly ? "text" : q.photoRequired ? "answer+photo" : "answer");
const withKind = (q: EditableQuestion, kind: string): EditableQuestion => ({
  ...q,
  photoOnly: kind === "photo",
  photoRequired: kind === "photo" || kind === "answer+photo",
  textOnly: kind === "text",
  noteRequired: kind === "photo" || kind === "text" ? false : q.noteRequired,
});

export function TemplateEditor({
  template,
  answerSets,
}: {
  template: { id: number | null; name: string; answerSetId: number; confirmationText: string; sections: ChecklistSection[] };
  answerSets: { id: number; name: string; options: AnswerOption[] }[];
}) {
  const [state, action, pending] = useActionState(saveTemplateAction, { error: null, version: 0 } as EditorState);
  const [name, setName] = useState(template.name);
  const [answerSetId, setAnswerSetId] = useState(template.answerSetId);
  const [confirmationText, setConfirmationText] = useState(template.confirmationText);
  const [sections, setSections] = useState<EditableSection[]>(template.sections);
  const setSection = (i: number, change: Partial<EditableSection>) => setSections((all) => all.map((s, n) => (n === i ? { ...s, ...change } : s)));
  const set = answerSets.find((a) => a.id === answerSetId);

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="template" value={JSON.stringify({ id: template.id, name, answerSetId, confirmationText, sections })} />
      <div className={card}>
        <label className="block space-y-1">
          <span className="font-semibold">Checklist name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Excavator daily inspection" className={field} />
        </label>
        <label className="block space-y-1">
          <span className="font-semibold">Answers</span>
          <select value={answerSetId} onChange={(e) => setAnswerSetId(Number(e.target.value))} className={field}>
            {answerSets.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}: {a.options.map((o) => o.label).join(" / ")}
              </option>
            ))}
          </select>
        </label>
        {set && (
          <div className="flex flex-wrap gap-1.5">
            {set.options.map((o) => (
              <span key={o.key} className="rounded-full px-2 py-0.5 text-xs text-white" style={{ backgroundColor: o.color }}>
                {o.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {sections.map((section, i) => (
        <div key={i} className={card}>
          <div className="flex items-center gap-2">
            <input
              value={section.title}
              onChange={(e) => setSection(i, { title: e.target.value })}
              placeholder="Section title, e.g. Walk-around"
              maxLength={80}
              className={`${field} font-semibold`}
              aria-label={`Section ${i + 1} title`}
            />
            <Reorder
              index={i}
              count={sections.length}
              label={`section ${section.title || i + 1}`}
              onMove={(by) => setSections((all) => move(all, i, by))}
              onRemove={() => {
                if (section.questions.length === 0 || confirm(`Remove the section "${section.title}" and its questions?`)) {
                  setSections((all) => all.filter((_, n) => n !== i));
                }
              }}
            />
          </div>
          <ol className="space-y-2">
            {section.questions.map((q, j) => (
              <li key={j} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                <span className="w-6 text-right text-sm text-slate-500">{j + 1}.</span>
                <input
                  value={q.text}
                  onChange={(e) =>
                    setSection(i, { questions: section.questions.map((x, n) => (n === j ? { ...x, text: e.target.value } : x)) })
                  }
                  placeholder="Question, e.g. Seatbelt in good condition and working"
                  maxLength={300}
                  className={field}
                  aria-label={`Question ${j + 1}`}
                />
                <select
                  value={kindOf(q)}
                  onChange={(e) =>
                    setSection(i, { questions: section.questions.map((x, n) => (n === j ? withKind(x, e.target.value) : x)) })
                  }
                  className="shrink-0 rounded-lg border border-slate-300 bg-transparent px-2 py-2 text-xs dark:border-slate-700"
                  aria-label={`How question ${j + 1} is answered`}
                >
                  {KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
                <label className="flex shrink-0 items-center gap-1 text-xs text-slate-600 dark:text-slate-400" title="Require a description when a defect is reported">
                  <input
                    type="checkbox"
                    disabled={q.photoOnly || q.textOnly}
                    checked={q.noteRequired}
                    onChange={(e) =>
                      setSection(i, { questions: section.questions.map((x, n) => (n === j ? { ...x, noteRequired: e.target.checked } : x)) })
                    }
                  />
                  Note on defect
                </label>
                <Reorder
                  index={j}
                  count={section.questions.length}
                  label={`question ${j + 1}`}
                  onMove={(by) => setSection(i, { questions: move(section.questions, j, by) })}
                  onRemove={() => setSection(i, { questions: section.questions.filter((_, n) => n !== j) })}
                />
              </li>
            ))}
          </ol>
          <button
            type="button"
            className="text-sm text-sky-700 hover:underline dark:text-sky-400"
            onClick={() => setSection(i, { questions: [...section.questions, { text: "", noteRequired: false }] })}
          >
            + Add question
          </button>
        </div>
      ))}
      <button
        type="button"
        className="rounded-lg border border-dashed border-slate-400 px-4 py-2 text-sm hover:bg-slate-50 dark:border-slate-600 dark:hover:bg-slate-800"
        onClick={() => setSections((all) => [...all, { title: "", questions: [{ text: "", noteRequired: false }] }])}
      >
        + Add section
      </button>

      <div className={card}>
        <label className="block space-y-1">
          <span className="font-semibold">Final confirmation</span>
          <span className="block text-xs text-slate-500">
            The operator ticks this before checking in. Use the wording your jurisdiction requires.
          </span>
          <textarea value={confirmationText} onChange={(e) => setConfirmationText(e.target.value)} required rows={3} maxLength={1000} className={field} />
        </label>
      </div>

      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex justify-end gap-3">
        <Link href="/checklists" className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          Cancel
        </Link>
        <button disabled={pending} className={primary}>
          {pending ? "Saving…" : "Save checklist"}
        </button>
      </div>
    </form>
  );
}

const SEVERITY_CHOICES: { value: Severity; label: string }[] = [
  { value: "pass", label: "OK (pass)" },
  { value: "minor", label: "Minor defect: repair needed" },
  { value: "major", label: "Major defect: repair needed, offers lockout" },
  { value: "na", label: "Not applicable (counts as a pass)" },
];

export function AnswerSetEditor({ answerSet }: { answerSet: { id: number | null; name: string; options: AnswerOption[] } }) {
  const [state, action, pending] = useActionState(saveAnswerSetAction, { error: null, version: 0 } as EditorState);
  const [name, setName] = useState(answerSet.name);
  const [options, setOptions] = useState<{ key?: string; label: string; severity: Severity; color: string }[]>(answerSet.options);
  const setOption = (i: number, change: Partial<(typeof options)[number]>) => setOptions((all) => all.map((o, n) => (n === i ? { ...o, ...change } : o)));

  return (
    <form action={action} className="space-y-4">
      <input type="hidden" name="answerSet" value={JSON.stringify({ id: answerSet.id, name, options })} />
      <div className={card}>
        <label className="block space-y-1">
          <span className="font-semibold">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} placeholder="e.g. Vehicle inspection" className={field} />
        </label>
      </div>
      <div className={card}>
        <div>
          <h2 className="font-semibold">Answers</h2>
          <p className="text-xs text-slate-500">
            The labels are up to you. What each one <em>means</em> decides what happens: defects raise &quot;Repair needed&quot;,
            and a major defect asks the operator whether to lock the machine out.
          </p>
        </div>
        <ol className="space-y-2">
          {options.map((o, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
              <input
                type="color"
                value={o.color}
                onChange={(e) => setOption(i, { color: e.target.value })}
                className="h-9 w-10 shrink-0 rounded border border-slate-300 dark:border-slate-700"
                aria-label={`Colour for answer ${i + 1}`}
              />
              <input value={o.label} onChange={(e) => setOption(i, { label: e.target.value })} placeholder="Label, e.g. Minor defect" maxLength={40} className={field} aria-label={`Answer ${i + 1}`} />
              <select value={o.severity} onChange={(e) => setOption(i, { severity: e.target.value as Severity })} className={`${field} sm:w-80`} aria-label={`Meaning of answer ${i + 1}`}>
                {SEVERITY_CHOICES.map((c) => (
                  <option key={c.value} value={c.value}>
                    {c.label}
                  </option>
                ))}
              </select>
              <Reorder
                index={i}
                count={options.length}
                label={`answer ${o.label || i + 1}`}
                onMove={(by) => setOptions((all) => move(all, i, by))}
                onRemove={() => setOptions((all) => all.filter((_, n) => n !== i))}
              />
            </li>
          ))}
        </ol>
        {options.length < 8 && (
          <button
            type="button"
            className="text-sm text-sky-700 hover:underline dark:text-sky-400"
            onClick={() => setOptions((all) => [...all, { label: "", severity: "minor", color: "#d97706" }])}
          >
            + Add answer
          </button>
        )}
        <p className="text-xs text-slate-500">Changing labels doesn&apos;t change past check-ins: they keep the answers as given.</p>
      </div>
      {state.error && <p className="text-sm text-red-600">{state.error}</p>}
      <div className="flex justify-end gap-3">
        <Link href="/checklists" className="rounded-lg border border-slate-300 px-4 py-2 hover:bg-slate-50 dark:border-slate-700 dark:hover:bg-slate-800">
          Cancel
        </Link>
        <button disabled={pending} className={primary}>
          {pending ? "Saving…" : "Save answers"}
        </button>
      </div>
    </form>
  );
}
