/**
 * Serial number help for the machine form (docs/scan-to-fill.md → VIN and PIN lookup):
 *  - On-road vehicles have a 17-character VIN. Its 9th character is a check digit (required on North American
 *    vehicles), which catches most misread characters. NHTSA's free vPIC service decodes make, model, year and type.
 *  - Heavy equipment has a 17-character PIN (Product Identification Number). There's no free public decoder, but the
 *    first three characters (the WMI) name the manufacturer; we recognise the common ones.
 * Only the number is sent to NHTSA (a VIN identifies a vehicle, not a person). Pure helpers are browser-safe.
 */

export const VIN_LENGTH = 17;
/** VINs and PINs never use I, O or Q (too easily confused with 1 and 0). */
const VIN_CHARS = /^[A-HJ-NPR-Z0-9]{17}$/;

/** Upper case, without spaces, dashes or dots (as plates are often printed). */
export const normalizeSerial = (s: string) => s.toUpperCase().replace(/[\s.\-]/g, "");

export const looksLikeVin = (s: string) => VIN_CHARS.test(s);

const VALUES: Record<string, number> = {
  A: 1, B: 2, C: 3, D: 4, E: 5, F: 6, G: 7, H: 8, J: 1, K: 2, L: 3, M: 4, N: 5, P: 7, R: 9,
  S: 2, T: 3, U: 4, V: 5, W: 6, X: 7, Y: 8, Z: 9,
};
const WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

/** The check digit (9th character) a VIN should have. */
export function vinCheckDigit(vin: string): string {
  let sum = 0;
  for (let i = 0; i < VIN_LENGTH; i++) {
    const c = vin[i];
    sum += (/\d/.test(c) ? Number(c) : (VALUES[c] ?? 0)) * WEIGHTS[i];
  }
  const r = sum % 11;
  return r === 10 ? "X" : String(r);
}

/** Heavy equipment manufacturers by the first three characters of their 17-character PINs. */
export const EQUIPMENT_WMI: Record<string, string> = {
  CAT: "Caterpillar",
  KMT: "Komatsu",
  VCE: "Volvo",
  JCB: "JCB",
  HCM: "Hitachi",
  "1T0": "John Deere",
  "1DW": "John Deere",
  "1FF": "John Deere",
  JAF: "Case",
  DHK: "Develon (Doosan)",
  HHK: "Hyundai",
};

export const equipmentMaker = (serial: string) => EQUIPMENT_WMI[serial.slice(0, 3)] ?? null;

export type Decoded = { make: string | null; model: string | null; year: number | null; machineType: string | null };

export type SerialLookup =
  | { kind: "vin"; serial: string; checkDigitOk: boolean; decoded: Decoded }
  | { kind: "pin"; serial: string; manufacturer: string }
  | { kind: "unknown"; serial: string; checkDigitOk: boolean | null; reason: string };

/** "FORD" → "Ford", "MERCEDES-BENZ" → "Mercedes-Benz"; leaves short all-caps names (GMC, JCB) and "(MPV)" alone. */
export function titleCase(s: string) {
  if (s.length <= 3) return s;
  // Bracketed abbreviations stay as written: "(MPV)".
  return s
    .split(/(\([^)]*\))/)
    .map((part) => (part.startsWith("(") ? part : part.toLowerCase().replace(/(^|[\s\-/])([a-z])/g, (_, sep: string, c: string) => sep + c.toUpperCase())))
    .join("");
}

type VpicResult = Record<string, string | null | undefined>;
type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** Decodes a VIN with NHTSA vPIC. Null when it doesn't know the VIN; "unavailable" when it can't be reached. */
export async function decodeVin(vin: string, fetchImpl: Fetch = fetch): Promise<Decoded | null | "unavailable"> {
  let row: VpicResult | undefined;
  try {
    const res = await fetchImpl(`https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues/${vin}?format=json`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return "unavailable";
    row = ((await res.json()) as { Results?: VpicResult[] }).Results?.[0];
  } catch {
    return "unavailable";
  }
  const v = (k: string) => {
    const s = row?.[k]?.trim();
    return s && s !== "Not Applicable" ? s : null;
  };
  const make = v("Make");
  if (!make) return null;
  const year = Number(v("ModelYear"));
  const type = v("BodyClass") ?? v("VehicleType");
  return {
    make: titleCase(make),
    model: v("Model"),
    year: Number.isInteger(year) && year > 1950 ? year : null,
    machineType: type ? titleCase(type).slice(0, 40) : null,
  };
}

/** What we can tell about a serial number: a decoded VIN, an equipment PIN's maker, or nothing. */
export async function lookupSerial(raw: string, fetchImpl: Fetch = fetch): Promise<SerialLookup> {
  const serial = normalizeSerial(raw);
  if (serial.length !== VIN_LENGTH) {
    return { kind: "unknown", serial, checkDigitOk: null, reason: "Not a 17-character VIN or PIN, so it can't be looked up." };
  }
  if (!looksLikeVin(serial)) {
    return { kind: "unknown", serial, checkDigitOk: null, reason: "VINs and PINs never contain I, O or Q: check for a misread 1 or 0." };
  }
  const manufacturer = equipmentMaker(serial);
  if (manufacturer) return { kind: "pin", serial, manufacturer };
  const checkDigitOk = vinCheckDigit(serial) === serial[8];
  const decoded = await decodeVin(serial, fetchImpl);
  if (decoded === "unavailable") return { kind: "unknown", serial, checkDigitOk, reason: "Couldn't reach NHTSA to decode it. Try again later." };
  if (decoded) return { kind: "vin", serial, checkDigitOk, decoded };
  return {
    kind: "unknown",
    serial,
    checkDigitOk,
    reason: checkDigitOk ? "NHTSA doesn't know this number (equipment PINs and many non-road machines aren't listed)." : "NHTSA doesn't know this number.",
  };
}
