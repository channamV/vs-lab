"use server";

import { redirect } from "next/navigation";
import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import {
  ChecklistError,
  createAnswerSet,
  createTemplate,
  deleteAnswerSet,
  deleteTemplate,
  setDefaultTemplate,
  updateAnswerSet,
  updateTemplate,
} from "@/lib/checklists";

/** Checklists are shared by the whole organization, so only managers/owners who see all of it edit them. */
async function requireEditor() {
  const auth = await requireAuth("manager");
  if (auth.divisionIds !== null) throw new ChecklistError("Only managers with access to the whole company can change checklists.");
  return auth;
}

export type EditorState = { error: string | null; version: number };

const TemplateJson = z.object({
  id: z.number().int().positive().nullable(),
  name: z.string().max(200),
  answerSetId: z.number().int().positive(),
  confirmationText: z.string().max(2000),
  sections: z
    .array(
      z.object({
        id: z.string().max(60).optional(),
        title: z.string().max(200),
        questions: z
          .array(
            z.object({
              id: z.string().max(60).optional(),
              text: z.string().max(600),
              noteRequired: z.boolean(),
              photoRequired: z.boolean().optional(),
              photoOnly: z.boolean().optional(),
            }),
          )
          .max(200),
      }),
    )
    .max(50),
});

export async function saveTemplateAction(prev: EditorState, formData: FormData): Promise<EditorState> {
  const auth = await requireEditor();
  const input = TemplateJson.parse(JSON.parse(String(formData.get("template") ?? "{}")));
  try {
    if (input.id) await updateTemplate(getDb(), auth.organizationId, input.id, input);
    else await createTemplate(getDb(), auth.organizationId, input);
  } catch (err) {
    if (err instanceof ChecklistError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  redirect("/checklists");
}

const AnswerSetJson = z.object({
  id: z.number().int().positive().nullable(),
  name: z.string().max(200),
  options: z.array(z.object({ key: z.string().max(60).optional(), label: z.string().max(100), severity: z.string().max(10), color: z.string().max(7) })).max(12),
});

export async function saveAnswerSetAction(prev: EditorState, formData: FormData): Promise<EditorState> {
  const auth = await requireEditor();
  const input = AnswerSetJson.parse(JSON.parse(String(formData.get("answerSet") ?? "{}")));
  try {
    if (input.id) await updateAnswerSet(getDb(), auth.organizationId, input.id, input);
    else await createAnswerSet(getDb(), auth.organizationId, input);
  } catch (err) {
    if (err instanceof ChecklistError) return { error: err.message, version: prev.version + 1 };
    throw err;
  }
  redirect("/checklists");
}

const Id = z.coerce.number().int().positive();

export async function setDefaultTemplateAction(formData: FormData) {
  const auth = await requireEditor();
  await setDefaultTemplate(getDb(), auth.organizationId, Id.parse(formData.get("id")));
  refresh();
}

export async function deleteTemplateAction(formData: FormData) {
  const auth = await requireEditor();
  await deleteTemplate(getDb(), auth.organizationId, Id.parse(formData.get("id")));
  refresh();
}

export async function deleteAnswerSetAction(formData: FormData) {
  const auth = await requireEditor();
  await deleteAnswerSet(getDb(), auth.organizationId, Id.parse(formData.get("id")));
  refresh();
}
