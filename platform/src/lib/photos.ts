import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { get, put } from "@vercel/blob";

/**
 * Where checklist photos are kept. Private: files are never public; pages show them through
 * /photos/<id>, which checks the viewer may see the machine.
 *  - BLOB_READ_WRITE_TOKEN set (Vercel, connected to the "vs-lab-photos" Blob store) → Vercel Blob, private.
 *  - Otherwise, on your own computer → files in PHOTO_DIR (default platform/.data/photos).
 *  - On Vercel without a Blob store → photos are switched off (required photos are then not enforced).
 */

export const PHOTO_RULES = {
  /** After the phone shrinks it; the phone makes them ~0.2 MB. */
  maxBytes: 1_500_000,
  maxPerQuestion: 3,
  /** A check-in's upload must stay under Vercel's ~4.5 MB request limit. */
  maxTotalBytes: 3_800_000,
  types: ["image/jpeg", "image/png", "image/webp"],
};

export type PhotoFile = { questionId: string; data: Uint8Array; contentType: string };

export function photoStorageAvailable(): boolean {
  return Boolean(process.env.BLOB_READ_WRITE_TOKEN) || !process.env.VERCEL;
}

const localDir = () => process.env.PHOTO_DIR || path.join(process.cwd(), ".data", "photos");

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };

/** Stores a photo and returns its key. The key is random, so it can't be guessed from the check-in. */
export async function savePhoto(organizationId: number, file: PhotoFile): Promise<string> {
  const key = `org-${organizationId}/${new Date().toISOString().slice(0, 10)}/${randomBytes(12).toString("hex")}.${EXT[file.contentType] ?? "bin"}`;
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    await put(key, Buffer.from(file.data), { access: "private", contentType: file.contentType, addRandomSuffix: false });
    return key;
  }
  if (!photoStorageAvailable()) throw new Error("Photo storage isn't set up (BLOB_READ_WRITE_TOKEN missing).");
  const full = path.join(localDir(), key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, file.data);
  return key;
}

/** Reads a stored photo, or null if it's missing. */
export async function readPhoto(key: string): Promise<ReadableStream<Uint8Array> | Uint8Array | null> {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const result = await get(key, { access: "private" });
    return result?.stream ?? null;
  }
  if (key.includes("..")) return null;
  try {
    return new Uint8Array(await readFile(path.join(localDir(), key)));
  } catch {
    return null;
  }
}
