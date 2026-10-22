import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";

/**
 * "Scan to fill" (docs/scan-to-fill.md): a photo (or PDF) of a training card or a machine's serial plate is read by
 * Claude, and the fields it finds are put into the form for a manager to check before saving. Nothing is saved
 * here; the image goes to Anthropic for this one request only. Needs ANTHROPIC_API_KEY (unset = no Scan buttons).
 */

export class ScanError extends Error {}

export const SCAN_RULES = {
  maxBytes: 3_800_000,
  types: ["image/jpeg", "image/png", "image/webp", "application/pdf"],
  model: "claude-opus-5-5",
};

export const scanAvailable = () => Boolean(process.env.ANTHROPIC_API_KEY);

export type ScanFile = { data: Uint8Array; contentType: string };

/** The part of the SDK client used here (tests pass a fake). */
export type ScanClient = { beta: { messages: { parse: Anthropic["beta"]["messages"]["parse"] } } };
let client: ScanClient | null = null;
const defaultClient = () => (client ??= new Anthropic());

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: string | null) => (v && DATE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const text = (v: string | null, max: number) => v?.trim().slice(0, max) || null;

const TrainingScan = z.object({
  readable: z.boolean().describe("False if this isn't a training certificate or card, or it can't be read."),
  holderName: z.string().nullable().describe("The person the certificate was issued to."),
  certificationAsPrinted: z.string().nullable().describe("The course or certification name as printed."),
  certification: z.string().nullable().describe("The matching name from the company's list, copied exactly, or null if none clearly matches."),
  issuedOn: z.string().nullable().describe("Issue / completion / training date, YYYY-MM-DD."),
  expiresOn: z.string().nullable().describe("Expiry / valid-until / renewal date, YYYY-MM-DD. Null if none is printed."),
  provider: z.string().nullable().describe("Training provider or issuing organization."),
  certificateNumber: z.string().nullable().describe("Certificate, card, licence or registration number."),
});

const PlateScan = z.object({
  readable: z.boolean().describe("False if this isn't an equipment identification / serial plate, or it can't be read."),
  make: z.string().nullable().describe("Manufacturer, e.g. Caterpillar, Komatsu, John Deere."),
  model: z.string().nullable().describe("Model, e.g. 320 or PC210LC-11."),
  year: z.number().int().nullable().describe("Year of manufacture, if printed."),
  serialNumber: z.string().nullable().describe("Product identification number (PIN), serial number or VIN, exactly as printed."),
  machineType: z.string().nullable().describe("Kind of machine if printed or clear from the plate, e.g. Excavator. Null if unsure."),
});

const INSTRUCTIONS =
  "You read photos of documents for a construction equipment platform. Report only what is printed; use null for anything " +
  "not visible or not legible rather than guessing. Write dates as YYYY-MM-DD; when a date is ambiguous between day and month " +
  "order, prefer the format the document uses elsewhere, and use null if you can't tell.";

async function read<T extends z.ZodType>(file: ScanFile, prompt: string, schema: T, api: ScanClient): Promise<z.infer<T>> {
  if (!SCAN_RULES.types.includes(file.contentType)) throw new ScanError("Scan a photo (JPEG, PNG, WebP) or a PDF.");
  if (file.data.byteLength > SCAN_RULES.maxBytes) throw new ScanError("The file is too big to scan (3.8 MB at most).");
  const data = Buffer.from(file.data).toString("base64");
  const source =
    file.contentType === "application/pdf"
      ? ({ type: "document", source: { type: "base64", media_type: "application/pdf", data } } as const)
      : ({ type: "image", source: { type: "base64", media_type: file.contentType as "image/jpeg" | "image/png" | "image/webp", data } } as const);
  let response;
  try {
    response = await api.beta.messages.parse({
      model: SCAN_RULES.model,
      max_tokens: 4000,
      // Reading a card is simple: low effort keeps it quick and cheap.
      output_config: { effort: "low", format: betaZodOutputFormat(schema) },
      // If a safety check declines the request, Anthropic retries it on its recommended model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: INSTRUCTIONS,
      messages: [{ role: "user", content: [source, { type: "text", text: prompt }] }],
    });
  } catch (err) {
    if (err instanceof Anthropic.APIError) {
      console.error("scan failed", err.status, err.message);
      throw new ScanError(err.status === 429 || (err.status ?? 0) >= 500 ? "The scanner is busy. Try again in a minute." : "The scan didn't work. Fill in the form by hand.");
    }
    throw err;
  }
  if (response.stop_reason === "refusal" || !response.parsed_output) throw new ScanError("The scan didn't work. Fill in the form by hand.");
  return response.parsed_output as z.infer<T>;
}

export type TrainingFields = {
  holderName: string | null;
  certificationAsPrinted: string | null;
  certificationTypeId: number | null;
  issuedOn: string | null;
  expiresOn: string | null;
  provider: string | null;
  certificateNumber: string | null;
};

/** Reads a training certificate. `types` are the company's certifications, so the scan can pick the matching one. */
export async function scanTrainingCertificate(file: ScanFile, types: { id: number; name: string }[], api: ScanClient = defaultClient()): Promise<TrainingFields> {
  const list = types.map((t) => `- ${t.name}`).join("\n");
  const out = await read(file, `Read this training certificate or card. The company's certifications are:\n${list}`, TrainingScan, api);
  if (!out.readable) throw new ScanError("That doesn't look like a readable training certificate. Try a sharper photo, or fill in the form by hand.");
  const wanted = out.certification?.trim().toLowerCase();
  const issuedOn = date(out.issuedOn);
  const expiresOn = date(out.expiresOn);
  return {
    holderName: text(out.holderName, 120),
    certificationAsPrinted: text(out.certificationAsPrinted, 120),
    certificationTypeId: types.find((t) => t.name.toLowerCase() === wanted)?.id ?? null,
    issuedOn,
    expiresOn: expiresOn && (!issuedOn || expiresOn > issuedOn) ? expiresOn : null,
    provider: text(out.provider, 120),
    certificateNumber: text(out.certificateNumber, 80),
  };
}

export type PlateFields = { make: string | null; model: string | null; year: number | null; serialNumber: string | null; machineType: string | null };

/** Reads a machine's identification / serial plate. */
export async function scanSerialPlate(file: ScanFile, api: ScanClient = defaultClient(), now = new Date()): Promise<PlateFields> {
  const out = await read(file, "Read this equipment identification plate.", PlateScan, api);
  if (!out.readable) throw new ScanError("That doesn't look like a readable serial plate. Try a sharper, straight-on photo.");
  const year = out.year !== null && out.year >= 1950 && out.year <= now.getFullYear() + 1 ? out.year : null;
  return {
    make: text(out.make, 40),
    model: text(out.model, 40),
    year,
    serialNumber: text(out.serialNumber?.replace(/\s+/g, "") ?? null, 40),
    machineType: text(out.machineType, 40),
  };
}

/** Rough check that the name on a card is the operator's (ignores case, punctuation and word order). */
export function sameName(a: string, b: string) {
  const words = (s: string) => new Set(s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z\s]/g, " ").split(/\s+/).filter((w) => w.length > 1));
  const x = words(a);
  const y = words(b);
  const shared = [...x].filter((w) => y.has(w)).length;
  return shared >= Math.min(2, x.size, y.size) && shared > 0;
}
