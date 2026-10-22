"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getDb } from "@/lib/db";
import { cancelUpdates, createRelease, FirmwareError, FIRMWARE_RULES, queueUpdate, retireRelease } from "@/lib/firmware";
import { requirePlatformAdmin } from "@/lib/session";

/** Platform admins (Veristart staff) only: firmware releases and over-the-air updates. */

export type UploadState = { error: string | null; version: number; values?: { version: string; notes: string } };

export async function uploadFirmwareAction(prev: UploadState, formData: FormData): Promise<UploadState> {
  const auth = await requirePlatformAdmin();
  const values = { version: String(formData.get("version") ?? "").slice(0, 60), notes: String(formData.get("notes") ?? "").slice(0, 1000) };
  const file = formData.get("file");
  const fail = (error: string) => ({ error, version: prev.version + 1, values });
  if (!(file instanceof File) || file.size === 0) return fail("Choose the firmware .bin file.");
  if (file.size > FIRMWARE_RULES.maxBytes) return fail("The file is too big (over 3.9 MB). Is it the firmware .bin?");
  let id: number;
  try {
    const release = await createRelease(getDb(), { ...values, fileName: file.name, data: new Uint8Array(await file.arrayBuffer()), uploadedBy: auth.email });
    id = release.id;
  } catch (err) {
    if (err instanceof FirmwareError) return fail(err.message);
    throw err;
  }
  redirect(`/platform/firmware/${id}`);
}

export type RolloutState = { error: string | null; message: string | null; version: number };

export async function sendUpdateAction(prev: RolloutState, formData: FormData): Promise<RolloutState> {
  const auth = await requirePlatformAdmin();
  const releaseId = z.coerce.number().int().positive().parse(formData.get("releaseId"));
  const deviceIds = formData.getAll("deviceId").map(String).filter((d) => /^[A-Za-z0-9_-]{1,32}$/.test(d));
  try {
    const { queued, skipped } = await queueUpdate(getDb(), releaseId, deviceIds, auth.email);
    refresh();
    return {
      error: null,
      message: `Queued for ${queued} device${queued === 1 ? "" : "s"}${skipped ? ` (${skipped} skipped: already on this version or already waiting)` : ""}. Each gets it at its next contact.`,
      version: prev.version + 1,
    };
  } catch (err) {
    if (err instanceof FirmwareError) return { error: err.message, message: null, version: prev.version + 1 };
    throw err;
  }
}

export async function cancelUpdatesAction(formData: FormData) {
  await requirePlatformAdmin();
  await cancelUpdates(getDb(), z.coerce.number().int().positive().parse(formData.get("releaseId")));
  refresh();
}

export async function retireReleaseAction(formData: FormData) {
  await requirePlatformAdmin();
  await retireRelease(getDb(), z.coerce.number().int().positive().parse(formData.get("releaseId")));
  refresh();
}
