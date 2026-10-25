import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  checklistAnswerSets,
  checklistIssues,
  checklistTemplates,
  machines,
  SEVERITIES,
  type AnswerOption,
  type ChecklistAnswer,
  type ChecklistSection,
  type Severity,
} from "@/lib/db/schema";

/**
 * Customizable pre-start checklists. Each organization has:
 *  - answer sets: the answers operators choose from, each with a meaning (pass / minor / major / n/a);
 *  - templates: sections of questions, one answer set, and a final confirmation statement;
 *  - a default template, used by machines that don't have one of their own.
 * Defects reported on check-ins become issues on the machine. A repeat report stacks onto the open
 * issue; only new or escalated issues raise "Repair needed". A major defect can lock the machine out.
 * Plain functions that take the database, so they can be tested without a server.
 */

export class ChecklistError extends Error {}

export const SEVERITY_LABELS: Record<Severity, string> = {
  pass: "Pass (OK)",
  minor: "Minor defect (repair needed)",
  major: "Major defect (repair needed, can lock out)",
  na: "Not applicable",
};

const RANK: Record<Severity, number> = { na: 0, pass: 0, minor: 1, major: 2 };

export const DEFAULT_ANSWER_SETS: { name: string; options: AnswerOption[] }[] = [
  {
    name: "Standard",
    options: [
      { key: "ok", label: "OK", severity: "pass", color: "#059669" },
      { key: "service_soon", label: "Service soon", severity: "minor", color: "#d97706" },
      { key: "lockout", label: "Lockout", severity: "major", color: "#dc2626" },
      { key: "na", label: "Not applicable", severity: "na", color: "#64748b" },
    ],
  },
  {
    name: "Vehicle inspection",
    options: [
      { key: "ok", label: "OK", severity: "pass", color: "#059669" },
      { key: "minor_defect", label: "Minor defect", severity: "minor", color: "#d97706" },
      { key: "major_defect", label: "Major defect", severity: "major", color: "#dc2626" },
      { key: "na", label: "Not applicable", severity: "na", color: "#64748b" },
    ],
  },
];

export const DEFAULT_CONFIRMATION = "I have inspected this equipment and confirm that it is safe to use.";

/** The questions VS Lab started with, now the default template. Ids are kept so history lines up. */
export const DEFAULT_SECTIONS: ChecklistSection[] = [
  {
    id: "walkaround",
    title: "Walk-around",
    questions: [
      { id: "walkaround", text: "Walk-around done: no visible damage", noteRequired: false },
      { id: "leaks", text: "No fluid leaks under or around the machine", noteRequired: false },
      { id: "fluids", text: "Engine oil, coolant and hydraulic oil levels OK", noteRequired: false },
      { id: "undercarriage", text: "Tracks / tires and undercarriage OK", noteRequired: false },
      { id: "attachments", text: "Bucket / attachment, pins and couplers secure", noteRequired: false },
    ],
  },
  {
    id: "cab",
    title: "Cab and safety equipment",
    questions: [
      { id: "lights", text: "Lights, horn and backup alarm working", noteRequired: false },
      { id: "seatbelt", text: "Seatbelt in good condition and working", noteRequired: false },
      { id: "extinguisher", text: "Fire extinguisher present and charged", noteRequired: false },
      { id: "visibility", text: "Mirrors, windows and camera clean and undamaged", noteRequired: false },
      { id: "controls", text: "Controls and safety lockout lever working", noteRequired: false },
    ],
  },
];

export const DEFAULT_TEMPLATE_NAME = "Standard pre-start";

/** Creates the default answer sets and template for an organization, if it has none yet. Safe to call repeatedly. */
export async function ensureChecklistDefaults(db: Db, organizationId: number) {
  const sets = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.organizationId, organizationId));
  if (sets.length === 0) {
    await db
      .insert(checklistAnswerSets)
      .values(DEFAULT_ANSWER_SETS.map((s) => ({ organizationId, ...s })))
      .onConflictDoNothing();
  }
  const [existingDefault] = await db
    .select({ id: checklistTemplates.id })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.organizationId, organizationId), eq(checklistTemplates.isDefault, true)));
  if (existingDefault) return;
  const [standard] = await db
    .select()
    .from(checklistAnswerSets)
    .where(eq(checklistAnswerSets.organizationId, organizationId))
    .orderBy(sql`${checklistAnswerSets.name} <> 'Standard'`, asc(checklistAnswerSets.id))
    .limit(1);
  await db
    .insert(checklistTemplates)
    .values({
      organizationId,
      name: DEFAULT_TEMPLATE_NAME,
      answerSetId: standard.id,
      sections: DEFAULT_SECTIONS,
      confirmationText: DEFAULT_CONFIRMATION,
      isDefault: true,
    })
    .onConflictDoNothing();
}

/** The checklist an operator sees on this machine: its own template, or the organization's default. */
export async function checklistForMachine(db: Db, machine: { organizationId: number; checklistTemplateId: number | null }) {
  await ensureChecklistDefaults(db, machine.organizationId);
  const rows = await db
    .select({ template: checklistTemplates, answerSet: checklistAnswerSets })
    .from(checklistTemplates)
    .innerJoin(checklistAnswerSets, eq(checklistAnswerSets.id, checklistTemplates.answerSetId))
    .where(eq(checklistTemplates.organizationId, machine.organizationId));
  const own = rows.find((r) => r.template.id === machine.checklistTemplateId);
  const chosen = own ?? rows.find((r) => r.template.isDefault)!;
  return { template: chosen.template, options: chosen.answerSet.options };
}

// ---------- Answering ----------

export type AnswerInput = {
  answers: Record<string, string | undefined>;
  notes?: Record<string, string | undefined>;
  /** How many photos the operator attached to each question. */
  photoCounts?: Record<string, number | undefined>;
  /** False when photo storage isn't available: required photos then aren't enforced. */
  enforcePhotos?: boolean;
};

export type Defect = { questionId: string; question: string; section: string; severity: "minor" | "major"; answerLabel: string; note: string | null };

export type Evaluation =
  | { ok: true; answers: ChecklistAnswer[]; defects: Defect[]; hasMajor: boolean }
  | { ok: false; reason: "incomplete" | "note-required" | "photo-required"; questions: string[] };

/**
 * Checks an operator's answers against the template: every question answered with one of the set's
 * options, and a note where the template asks for one on a defect. Returns the answers as they'll be
 * stored (question and answer text included) and the defects found.
 */
export function evaluateAnswers(sections: ChecklistSection[], options: AnswerOption[], input: AnswerInput): Evaluation {
  const byKey = new Map(options.map((o) => [o.key, o]));
  const answers: ChecklistAnswer[] = [];
  const defects: Defect[] = [];
  const missing: string[] = [];
  const needNote: string[] = [];
  const needPhoto: string[] = [];
  const enforcePhotos = input.enforcePhotos ?? true;
  for (const section of sections) {
    for (const q of section.questions) {
      const photos = input.photoCounts?.[q.id] ?? 0;
      if ((q.photoRequired || q.photoOnly) && photos === 0 && enforcePhotos) needPhoto.push(q.text);
      if (q.photoOnly) {
        // A photo step: the photo is the answer.
        answers.push({ id: q.id, question: q.text, section: section.title, answer: photos ? "Photo taken" : "No photo", severity: "pass", ok: true, photoOnly: true });
        continue;
      }
      if (q.textOnly) {
        // A written answer (odometer, location...): the text is the answer.
        const written = input.notes?.[q.id]?.trim().slice(0, 500);
        if (!written) missing.push(q.text);
        else answers.push({ id: q.id, question: q.text, section: section.title, answer: written, severity: "pass", ok: true, textOnly: true });
        continue;
      }
      const option = byKey.get(input.answers[q.id] ?? "");
      if (!option) {
        missing.push(q.text);
        continue;
      }
      const note = input.notes?.[q.id]?.trim().slice(0, 500) || null;
      const isDefect = option.severity === "minor" || option.severity === "major";
      if (isDefect && q.noteRequired && !note) needNote.push(q.text);
      answers.push({
        id: q.id,
        question: q.text,
        section: section.title,
        answer: option.label,
        severity: option.severity,
        ok: !isDefect,
        ...(note && { note }),
      });
      if (isDefect) {
        defects.push({ questionId: q.id, question: q.text, section: section.title, severity: option.severity as "minor" | "major", answerLabel: option.label, note });
      }
    }
  }
  if (missing.length) return { ok: false, reason: "incomplete", questions: missing };
  if (needNote.length) return { ok: false, reason: "note-required", questions: needNote };
  if (needPhoto.length) return { ok: false, reason: "photo-required", questions: needPhoto };
  return { ok: true, answers, defects, hasMajor: defects.some((d) => d.severity === "major") };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * Adds a check-in's defects to the machine's open issues. A defect already open stacks (count, latest
 * report); reported as more severe, it escalates. New and escalated issues are marked with this check-in,
 * which is what raises the "Repair needed" alert. Returns how many were new/escalated and how many repeats.
 */
export async function recordIssues(
  db: Db | Tx,
  input: { organizationId: number; machineId: number; checkinId: number; defects: Defect[]; now: Date },
) {
  let raised = 0;
  let repeated = 0;
  for (const d of input.defects) {
    const [open] = await db
      .select()
      .from(checklistIssues)
      .where(and(eq(checklistIssues.machineId, input.machineId), eq(checklistIssues.questionId, d.questionId), isNull(checklistIssues.resolvedAt)));
    if (!open) {
      await db.insert(checklistIssues).values({
        organizationId: input.organizationId,
        machineId: input.machineId,
        questionId: d.questionId,
        question: d.question,
        section: d.section,
        severity: d.severity,
        answerLabel: d.answerLabel,
        note: d.note,
        firstReportedAt: input.now,
        lastReportedAt: input.now,
        firstCheckinId: input.checkinId,
        lastCheckinId: input.checkinId,
        alertCheckinId: input.checkinId,
      });
      raised++;
      continue;
    }
    const escalated = RANK[d.severity] > RANK[open.severity as Severity];
    await db
      .update(checklistIssues)
      .set({
        reportCount: open.reportCount + 1,
        lastReportedAt: input.now,
        lastCheckinId: input.checkinId,
        answerLabel: d.answerLabel,
        note: d.note ?? open.note,
        question: d.question,
        ...(escalated && { severity: d.severity, alertCheckinId: input.checkinId }),
      })
      .where(eq(checklistIssues.id, open.id));
    if (escalated) raised++;
    else repeated++;
  }
  return { raised, repeated };
}

// ---------- Issues and lockout (managers) ----------

export async function resolveIssue(db: Db, organizationId: number, issueId: number, userId: number, note: string, now = new Date()) {
  await db
    .update(checklistIssues)
    .set({ resolvedAt: now, resolvedByUserId: userId, resolutionNote: note.trim().slice(0, 500) || null })
    .where(and(eq(checklistIssues.id, issueId), eq(checklistIssues.organizationId, organizationId), isNull(checklistIssues.resolvedAt)));
}

/** A manager returns a locked-out machine to service (after the repair). */
export async function clearLockout(db: Db, organizationId: number, machineId: number) {
  await db
    .update(machines)
    .set({ lockedOutAt: null, lockedOutReason: null, lockedOutCheckinId: null })
    .where(and(eq(machines.id, machineId), eq(machines.organizationId, organizationId)));
}

// ---------- Editing templates and answer sets (managers) ----------

const ID = /^[a-z0-9_-]{1,40}$/;

/** Short readable ids for new questions and answers; existing ones keep theirs so issues keep stacking. */
function slug(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 30) || "item";
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
  taken.add(id);
  return id;
}

export type TemplateInput = {
  name: string;
  answerSetId: number;
  confirmationText: string;
  sections: { id?: string; title: string; questions: { id?: string; text: string; noteRequired?: boolean; photoRequired?: boolean; photoOnly?: boolean; textOnly?: boolean }[] }[];
};

async function cleanTemplate(db: Db, organizationId: number, input: TemplateInput, exceptId?: number) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ChecklistError("Enter the checklist's name.");
  const [taken] = await db
    .select({ id: checklistTemplates.id })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.organizationId, organizationId), eq(checklistTemplates.name, name), exceptId ? ne(checklistTemplates.id, exceptId) : undefined));
  if (taken) throw new ChecklistError(`There's already a checklist called ${name}.`);
  const [set] = await db
    .select({ id: checklistAnswerSets.id })
    .from(checklistAnswerSets)
    .where(and(eq(checklistAnswerSets.id, input.answerSetId), eq(checklistAnswerSets.organizationId, organizationId)));
  if (!set) throw new ChecklistError("Choose an answer set.");
  const confirmationText = input.confirmationText.trim().slice(0, 1000);
  if (!confirmationText) throw new ChecklistError("Enter the confirmation statement operators agree to.");

  const sectionIds = new Set<string>();
  const questionIds = new Set<string>();
  // Keep valid existing ids first, so a renamed question keeps its id.
  for (const s of input.sections) for (const q of s.questions) if (q.id && ID.test(q.id) && !questionIds.has(q.id)) questionIds.add(q.id);
  const seen = new Set<string>();
  const sections: ChecklistSection[] = [];
  for (const s of input.sections) {
    const title = s.title.trim().slice(0, 80);
    const questions = s.questions
      .map((q) => ({ ...q, text: q.text.trim().slice(0, 300) }))
      .filter((q) => q.text)
      .map((q) => {
        const keep = q.id && ID.test(q.id) && !seen.has(q.id);
        const id = keep ? q.id! : slug(q.text, questionIds);
        seen.add(id);
        const photoOnly = Boolean(q.photoOnly);
        const textOnly = !photoOnly && Boolean(q.textOnly);
        return {
          id,
          text: q.text,
          noteRequired: photoOnly || textOnly ? false : Boolean(q.noteRequired),
          photoRequired: photoOnly || Boolean(q.photoRequired),
          photoOnly,
          ...(textOnly && { textOnly }),
        };
      });
    if (questions.length === 0) continue;
    if (!title) throw new ChecklistError("Every section needs a title.");
    const id = s.id && ID.test(s.id) && !sectionIds.has(s.id) ? s.id : slug(title, sectionIds);
    sectionIds.add(id);
    sections.push({ id, title, questions });
  }
  if (sections.length === 0) throw new ChecklistError("Add at least one question.");
  return { name, answerSetId: input.answerSetId, confirmationText, sections };
}

export async function createTemplate(db: Db, organizationId: number, input: TemplateInput) {
  await ensureChecklistDefaults(db, organizationId);
  const values = await cleanTemplate(db, organizationId, input);
  const [row] = await db.insert(checklistTemplates).values({ organizationId, ...values }).returning();
  return row;
}

/** Saves a template. Past check-ins keep the questions as they were asked. */
export async function updateTemplate(db: Db, organizationId: number, templateId: number, input: TemplateInput) {
  const values = await cleanTemplate(db, organizationId, input, templateId);
  const updated = await db
    .update(checklistTemplates)
    .set({ ...values, updatedAt: new Date() })
    .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.organizationId, organizationId)))
    .returning({ id: checklistTemplates.id });
  if (updated.length === 0) throw new ChecklistError("Checklist not found.");
}

export async function setDefaultTemplate(db: Db, organizationId: number, templateId: number) {
  const [template] = await db
    .select({ id: checklistTemplates.id })
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.organizationId, organizationId)));
  if (!template) throw new ChecklistError("Checklist not found.");
  await db.transaction(async (tx) => {
    await tx.update(checklistTemplates).set({ isDefault: false }).where(eq(checklistTemplates.organizationId, organizationId));
    await tx.update(checklistTemplates).set({ isDefault: true }).where(eq(checklistTemplates.id, templateId));
  });
}

/** Deletes a template that isn't the default. Machines using it switch to the default. */
export async function deleteTemplate(db: Db, organizationId: number, templateId: number) {
  const [template] = await db
    .select()
    .from(checklistTemplates)
    .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.organizationId, organizationId)));
  if (!template) throw new ChecklistError("Checklist not found.");
  if (template.isDefault) throw new ChecklistError("This is the default checklist. Make another one the default first.");
  await db.delete(checklistTemplates).where(eq(checklistTemplates.id, templateId));
}

/** Puts a machine on a template (null = the organization's default). */
export async function setMachineTemplate(db: Db, organizationId: number, machineId: number, templateId: number | null) {
  if (templateId !== null) {
    const [template] = await db
      .select({ id: checklistTemplates.id })
      .from(checklistTemplates)
      .where(and(eq(checklistTemplates.id, templateId), eq(checklistTemplates.organizationId, organizationId)));
    if (!template) throw new ChecklistError("Checklist not found.");
  }
  await db
    .update(machines)
    .set({ checklistTemplateId: templateId })
    .where(and(eq(machines.id, machineId), eq(machines.organizationId, organizationId)));
}

export type AnswerSetInput = { name: string; options: { key?: string; label: string; severity: string; color?: string }[] };

const COLOR = /^#[0-9a-f]{6}$/i;
const DEFAULT_COLOR: Record<Severity, string> = { pass: "#059669", minor: "#d97706", major: "#dc2626", na: "#64748b" };

async function cleanAnswerSet(db: Db, organizationId: number, input: AnswerSetInput, exceptId?: number) {
  const name = input.name.trim().slice(0, 80);
  if (!name) throw new ChecklistError("Enter the answer set's name.");
  const [taken] = await db
    .select({ id: checklistAnswerSets.id })
    .from(checklistAnswerSets)
    .where(and(eq(checklistAnswerSets.organizationId, organizationId), eq(checklistAnswerSets.name, name), exceptId ? ne(checklistAnswerSets.id, exceptId) : undefined));
  if (taken) throw new ChecklistError(`There's already an answer set called ${name}.`);
  const keys = new Set<string>();
  for (const o of input.options) if (o.key && ID.test(o.key) && !keys.has(o.key)) keys.add(o.key);
  const seen = new Set<string>();
  const labels = new Set<string>();
  const options: AnswerOption[] = [];
  for (const o of input.options) {
    const label = o.label.trim().slice(0, 40);
    if (!label) continue;
    if (labels.has(label.toLowerCase())) throw new ChecklistError(`"${label}" is listed twice.`);
    labels.add(label.toLowerCase());
    if (!(SEVERITIES as readonly string[]).includes(o.severity)) throw new ChecklistError("Choose what each answer means.");
    const severity = o.severity as Severity;
    const key = o.key && ID.test(o.key) && !seen.has(o.key) ? o.key : slug(label, keys);
    seen.add(key);
    options.push({ key, label, severity, color: o.color && COLOR.test(o.color) ? o.color : DEFAULT_COLOR[severity] });
  }
  if (options.length < 2) throw new ChecklistError("An answer set needs at least two answers.");
  if (!options.some((o) => o.severity === "pass")) throw new ChecklistError("Include at least one answer that means OK.");
  return { name, options };
}

export async function createAnswerSet(db: Db, organizationId: number, input: AnswerSetInput) {
  const values = await cleanAnswerSet(db, organizationId, input);
  const [row] = await db.insert(checklistAnswerSets).values({ organizationId, ...values }).returning();
  return row;
}

/** Saves an answer set. Past check-ins keep the answer labels as they were. */
export async function updateAnswerSet(db: Db, organizationId: number, answerSetId: number, input: AnswerSetInput) {
  const values = await cleanAnswerSet(db, organizationId, input, answerSetId);
  const updated = await db
    .update(checklistAnswerSets)
    .set(values)
    .where(and(eq(checklistAnswerSets.id, answerSetId), eq(checklistAnswerSets.organizationId, organizationId)))
    .returning({ id: checklistAnswerSets.id });
  if (updated.length === 0) throw new ChecklistError("Answer set not found.");
}

export async function deleteAnswerSet(db: Db, organizationId: number, answerSetId: number) {
  const [used] = await db.select({ id: checklistTemplates.id }).from(checklistTemplates).where(eq(checklistTemplates.answerSetId, answerSetId)).limit(1);
  if (used) throw new ChecklistError("A checklist uses this answer set. Change that checklist first.");
  await db
    .delete(checklistAnswerSets)
    .where(and(eq(checklistAnswerSets.id, answerSetId), eq(checklistAnswerSets.organizationId, organizationId)));
}
