/**
 * Worksite kinds and the geometry used to match machines to them. No server-only code here: the map
 * editor (browser) uses it too. Database logic is in src/lib/worksites.ts.
 */

/** Kinds of place, with their map colours (the same as Veristart Insights). */
export const WORKSITE_TYPES = {
  worksite: { label: "Worksite (job site)", color: "#f59e0b" },
  company_facility: { label: "Company facility", color: "#3b82f6" },
  yard_storage: { label: "Yard / storage", color: "#14b8a6" },
  service_facility: { label: "Service facility", color: "#8b5cf6" },
  fuel_depot: { label: "Fuel depot", color: "#ef4444" },
  customer_site: { label: "Customer site", color: "#22c55e" },
  other: { label: "Other", color: "#6b7280" },
} as const;
export type WorksiteType = keyof typeof WORKSITE_TYPES;
export const isWorksiteType = (value: string): value is WorksiteType => value in WORKSITE_TYPES;
export const worksiteColor = (type: string) => WORKSITE_TYPES[type as WorksiteType]?.color ?? WORKSITE_TYPES.other.color;

/** [lat, lng] corners, in order, not closed. */
export type Polygon = [number, number][];

export const POLYGON_LIMITS = { minPoints: 3, maxPoints: 200, minAreaM2: 100, maxAreaKm2: 2500 };

/** Metres per degree, for the small distances involved (a flat projection around the polygon). */
function projector(lat0: number) {
  const ky = 111_320;
  const kx = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  return (lat: number, lng: number): [number, number] => [lng * kx, lat * ky];
}

/** Whether a point is inside the polygon (ray casting). */
export function pointInPolygon(lat: number, lng: number, polygon: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [yi, xi] = polygon[i];
    const [yj, xj] = polygon[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Shortest distance in metres from a point to the polygon's edge (inside or outside). */
export function distanceToEdgeM(lat: number, lng: number, polygon: Polygon): number {
  const project = projector(lat);
  const [px, py] = project(lat, lng);
  let best = Infinity;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [ax, ay] = project(...polygon[j]);
    const [bx, by] = project(...polygon[i]);
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    best = Math.min(best, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return best;
}

export function areaM2(polygon: Polygon): number {
  const project = projector(polygon.reduce((s, p) => s + p[0], 0) / polygon.length);
  const pts = polygon.map((p) => project(...p));
  let sum = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) sum += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
  return Math.abs(sum / 2);
}

/** The average of the corners (good enough for labels and "fly to"). */
export function centroid(polygon: Polygon): { lat: number; lng: number } {
  return {
    lat: polygon.reduce((s, p) => s + p[0], 0) / polygon.length,
    lng: polygon.reduce((s, p) => s + p[1], 0) / polygon.length,
  };
}

/** A cleaned-up polygon, or an error message saying what's wrong with it. */
export function checkPolygon(input: unknown): { ok: true; polygon: Polygon } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Draw the boundary on the map." };
  const polygon: Polygon = [];
  for (const p of input) {
    if (!Array.isArray(p) || p.length !== 2) return { ok: false, error: "The boundary isn't valid." };
    const [lat, lng] = p.map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      return { ok: false, error: "The boundary isn't valid." };
    }
    const point: [number, number] = [Number(lat.toFixed(7)), Number(lng.toFixed(7))];
    const last = polygon.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) polygon.push(point);
  }
  if (polygon.length > 1 && polygon[0][0] === polygon.at(-1)![0] && polygon[0][1] === polygon.at(-1)![1]) polygon.pop();
  const { minPoints, maxPoints, minAreaM2, maxAreaKm2 } = POLYGON_LIMITS;
  if (polygon.length < minPoints) return { ok: false, error: `The boundary needs at least ${minPoints} corners.` };
  if (polygon.length > maxPoints) return { ok: false, error: `The boundary can have at most ${maxPoints} corners.` };
  const area = areaM2(polygon);
  if (area < minAreaM2) return { ok: false, error: "The area is too small (draw at least 10 m × 10 m)." };
  if (area > maxAreaKm2 * 1_000_000) return { ok: false, error: `The area is too large (at most ${maxAreaKm2} km²).` };
  return { ok: true, polygon };
}
