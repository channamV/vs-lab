import { getDb } from "@/lib/db";
import type { SampleFields } from "@/lib/freematics/protocol";
import { ingestSamples, isValidDeviceId, UnknownDeviceError } from "@/lib/telemetry/ingest";

const KNOTS_TO_KPH = 1.852;

/**
 * Location upload from the Freematics Telelogger ("HTTPS GET" transport — GPS only, OsmAnd-style).
 * The device sends: GET /hub/api/push?id=<ID>&timestamp=<iso>&lat=..&lon=..&altitude=..&speed=<knots>&heading=..
 * Prefer HTTPS POST: it also sends battery, signal, motion and OBD data.
 */
export async function GET(request: Request) {
  const q = new URL(request.url).searchParams;
  const id = q.get("id") ?? "";
  if (!isValidDeviceId(id)) return new Response("Bad device ID", { status: 400 });

  const sample: SampleFields = {};
  const set = (name: string, param: string, scale = 1) => {
    const raw = q.get(param);
    if (raw === null || raw === "") return;
    const value = Number(raw);
    if (Number.isFinite(value)) sample[name] = value * scale;
  };
  set("lat", "lat");
  set("lng", "lon");
  set("altitudeM", "altitude");
  set("speedKph", "speed", KNOTS_TO_KPH);
  set("heading", "heading");

  try {
    const count = await ingestSamples(getDb(), id, Object.keys(sample).length ? [sample] : []);
    return new Response(`OK ${count}`);
  } catch (err) {
    if (err instanceof UnknownDeviceError) return new Response("Unknown device", { status: 403 });
    throw err;
  }
}
