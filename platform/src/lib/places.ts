import { eq } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { placeNames } from "@/lib/db/schema";

/**
 * "Mount Pearl, NL" for a position, to start checklist answers like "Place of inspection" (the operator can change
 * it). From OpenStreetMap's Nominatim (free; one request per second at most, so results are kept per ~1 km square
 * for PLACE_RULES.cacheDays and a lookup that fails just leaves the answer empty).
 */

export const PLACE_RULES = {
  /** Positions are rounded to this many decimals (0.01° ≈ 1 km) for the cache. */
  decimals: 2,
  cacheDays: 180,
  timeoutMs: 4000,
};

type NominatimAddress = Record<string, string | undefined>;

/** The town and province/state from a Nominatim address (pure): "Mount Pearl, NL", "Paradise, NL", "Boston, MA". */
export function placeFromAddress(address: NominatimAddress | undefined): string | null {
  if (!address) return null;
  const town = address.city ?? address.town ?? address.village ?? address.hamlet ?? address.municipality ?? address.suburb ?? address.county;
  const iso = address["ISO3166-2-lvl4"] ?? address["ISO3166-2-lvl3"];
  const region = iso && /^(CA|US)-/.test(iso) ? iso.slice(3) : (address.state ?? address.province ?? null);
  const name = [town, region].filter(Boolean).join(", ");
  return name || null;
}

const keyFor = (lat: number, lng: number) => `${lat.toFixed(PLACE_RULES.decimals)},${lng.toFixed(PLACE_RULES.decimals)}`;

/** The place name for a position, from the cache or Nominatim. Null when unknown or the lookup fails. */
export async function placeName(db: Db, lat: number, lng: number, now = new Date(), fetcher: typeof fetch = fetch): Promise<string | null> {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const key = keyFor(lat, lng);
  const [cached] = await db.select().from(placeNames).where(eq(placeNames.key, key));
  if (cached && now.getTime() - cached.fetchedAt.getTime() < PLACE_RULES.cacheDays * 86_400_000) return cached.name;
  try {
    const [qLat, qLng] = key.split(",");
    const res = await fetcher(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&addressdetails=1&lat=${qLat}&lon=${qLng}`, {
      headers: { "User-Agent": "vs-lab-platform (Veristart equipment safety lab)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(PLACE_RULES.timeoutMs),
    });
    if (!res.ok) return cached?.name ?? null;
    const name = placeFromAddress(((await res.json()) as { address?: NominatimAddress }).address);
    await db
      .insert(placeNames)
      .values({ key, name, fetchedAt: now })
      .onConflictDoUpdate({ target: placeNames.key, set: { name, fetchedAt: now } });
    return name;
  } catch {
    return cached?.name ?? null;
  }
}
