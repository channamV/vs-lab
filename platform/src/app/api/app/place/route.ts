import { getDb } from "@/lib/db";
import { fail, json, withApp } from "@/lib/app-api";
import { placeName } from "@/lib/places";

/** POST { lat, lng }: "Town, PROV" for the phone's position (checklist questions that start with the town). */
export async function POST(request: Request) {
  return withApp(request, async () => {
    const body = (await request.json().catch(() => ({}))) as { lat?: unknown; lng?: unknown };
    const lat = Number(body.lat);
    const lng = Number(body.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return fail("Bad position.");
    return json({ place: await placeName(getDb(), lat, lng) });
  });
}
