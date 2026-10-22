"use server";

import { refresh } from "next/cache";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requireAuth } from "@/lib/session";
import { parseSiteSpeedLimit, SafetyError } from "@/lib/safety";
import { createWorksite, deleteWorksite, setWorksitePerimeter, updateWorksite, WorksiteError } from "@/lib/worksites";

/** Managers and owners who see the whole organization (worksites are shared by all divisions). */
async function requireEditor() {
  const auth = await requireAuth("manager");
  if (auth.divisionIds !== null) throw new Error("You don't have permission to do that.");
  return auth;
}

export type WorksiteFormState = { error: string | null; savedId: number | null; version: number };

const Details = z.object({
  id: z.string().regex(/^\d*$/),
  name: z.string().max(80),
  type: z.string().max(40),
  notes: z.string().max(500),
  dwellHours: z.string().max(10),
  speedLimit: z.string().max(10),
});

/** New worksite (with its drawn boundary) or changed details. */
export async function saveWorksiteAction(prev: WorksiteFormState, formData: FormData): Promise<WorksiteFormState> {
  const auth = await requireEditor();
  const input = Details.parse({
    id: formData.get("id") ?? "",
    name: formData.get("name") ?? "",
    type: formData.get("type") ?? "",
    notes: formData.get("notes") ?? "",
    dwellHours: formData.get("dwellHours") ?? "",
    speedLimit: formData.get("speedLimit") ?? "",
  });
  const fail = (error: string) => ({ error, savedId: null, version: prev.version + 1 });
  let dwellLimitMinutes: number | null = null;
  if (input.dwellHours.trim()) {
    const hours = Number(input.dwellHours);
    if (!Number.isFinite(hours) || hours <= 0) return fail("Enter the time limit in hours, e.g. 8 or 0.5.");
    dwellLimitMinutes = Math.round(hours * 60);
  }
  let speedLimitKph: number | null;
  try {
    speedLimitKph = parseSiteSpeedLimit(input.speedLimit);
  } catch (err) {
    if (err instanceof SafetyError) return fail(err.message);
    throw err;
  }
  const details = { name: input.name, type: input.type, notes: input.notes, dwellLimitMinutes, speedLimitKph };
  const db = getDb();
  let savedId: number;
  try {
    if (input.id) {
      savedId = Number(input.id);
      await updateWorksite(db, auth.organizationId, savedId, details);
    } else {
      const polygon: unknown = JSON.parse(String(formData.get("polygon") ?? "null"));
      savedId = (await createWorksite(db, auth.organizationId, auth.userId, { ...details, polygon })).id;
    }
  } catch (err) {
    if (err instanceof WorksiteError) return fail(err.message);
    if (err instanceof SyntaxError) return fail("Draw the boundary on the map.");
    throw err;
  }
  refresh();
  return { error: null, savedId, version: prev.version + 1 };
}

export async function savePerimeterAction(id: number, polygon: [number, number][]): Promise<{ error: string | null }> {
  const auth = await requireEditor();
  try {
    await setWorksitePerimeter(getDb(), auth.organizationId, z.number().int().positive().parse(id), polygon);
  } catch (err) {
    if (err instanceof WorksiteError) return { error: err.message };
    throw err;
  }
  refresh();
  return { error: null };
}

export async function deleteWorksiteAction(id: number): Promise<{ error: string | null }> {
  const auth = await requireEditor();
  try {
    await deleteWorksite(getDb(), auth.organizationId, z.number().int().positive().parse(id));
  } catch (err) {
    if (err instanceof WorksiteError) return { error: err.message };
    throw err;
  }
  refresh();
  return { error: null };
}
