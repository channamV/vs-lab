import { describe, expect, it } from "vitest";
import type { CachedRoad } from "@/lib/db/schema";
import { matchToRoads, parseMaxspeed, postedSpeedingSpells, roadCoverageKm, roadFromOsm, tileBounds, tileKey, tilesNear, type RoadPoint } from "./road-limits";

/** A straight east–west road at a latitude, from lng -75.02 to -74.98. */
const road = (id: number, lat: number, extra: Partial<CachedRoad> = {}): CachedRoad => ({
  id,
  name: `Road ${id}`,
  highway: "primary",
  oneway: 0,
  limit: 50,
  forward: null,
  backward: null,
  points: [
    [lat, -75.02],
    [lat, -75.0],
    [lat, -74.98],
  ],
  ...extra,
});
/** A point driving east (heading 90) at a latitude, one per second. */
const pt = (s: number, lat: number, kph: number, heading = 90, lng = -75.01 + s * 0.0002): RoadPoint => ({ t: s * 1000, lat, lng, kph, heading, satellites: 8 });

describe("maxspeed tags", () => {
  it("reads km/h and mph, and leaves zone codes unknown", () => {
    expect(parseMaxspeed("50")).toBe(50);
    expect(parseMaxspeed("80 km/h")).toBe(80);
    expect(parseMaxspeed("30 mph")).toBe(48);
    expect(parseMaxspeed("60;80")).toBe(60);
    for (const t of ["CA:urban", "none", "signals", "walk", "", undefined, "0"]) expect(parseMaxspeed(t)).toBeNull();
  });

  it("turns Overpass ways into roads, skipping paths and service roads", () => {
    const way = { id: 7, tags: { highway: "secondary", name: "Main St", maxspeed: "60", oneway: "yes" }, geometry: [{ lat: 45, lon: -75 }, { lat: 45.001, lon: -75 }] };
    expect(roadFromOsm(way)).toMatchObject({ id: 7, name: "Main St", limit: 60, oneway: 1, points: [[45, -75], [45.001, -75]] });
    expect(roadFromOsm({ ...way, tags: { highway: "service" } })).toBeNull();
    expect(roadFromOsm({ ...way, tags: { highway: "footway" } })).toBeNull();
  });
});

describe("map squares", () => {
  it("names squares and includes a neighbour near an edge", () => {
    expect(tileKey(45.01, -75.01)).toBe("900:-1501");
    expect(tileBounds("900:-1501")).toEqual([45, -75.05, 45.05, -75]);
    expect(tilesNear(45.025, -75.025)).toEqual(["900:-1501"]);
    expect(tilesNear(45.0001, -75.025).sort()).toEqual(["899:-1501", "900:-1501"]);
  });
});

describe("matching", () => {
  it("picks the nearest road, and nothing when off-road", () => {
    const roads = [road(1, 45), road(2, 45.0004)]; // ~45 m apart
    const m = matchToRoads([pt(0, 45.00005, 40), pt(1, 45.00035, 40), pt(2, 45.002, 10)], roads);
    expect(m.map((p) => p.road?.id ?? null)).toEqual([1, 2, null]);
  });

  it("uses heading: a north–south street crossing doesn't steal an east–west driver", () => {
    const cross: CachedRoad = { ...road(3, 0), limit: 30, points: [[44.999, -75.0098], [45.001, -75.0098]] };
    const m = matchToRoads([pt(0, 45.0001, 60), pt(1, 45.0001, 60)], [road(1, 45, { limit: 80 }), cross]);
    expect(m.map((p) => p.limit)).toEqual([80, 80]);
  });

  it("applies per-direction limits", () => {
    const r = road(1, 45, { limit: null, forward: 70, backward: 50 });
    expect(matchToRoads([pt(0, 45, 60, 90)], [r])[0].limit).toBe(70); // east = along the points
    expect(matchToRoads([pt(0, 45, 60, 270)], [r])[0].limit).toBe(50);
    expect(matchToRoads([pt(0, 45, 2, 270)], [r])[0].limit).toBe(50); // heading unusable: the lower one
  });
});

describe("spells over the posted limit", () => {
  const roads = [road(1, 45)]; // 50 km/h
  const run = (speeds: number[], tolerance = 10) =>
    postedSpeedingSpells(
      matchToRoads(
        speeds.map((k, s) => pt(s, 45, k)),
        roads,
      ),
      tolerance,
    );

  it("needs more than the tolerance for at least 10 seconds", () => {
    expect(run(Array(20).fill(54))).toEqual([]); // within 10 %
    expect(run([...Array(5).fill(70), ...Array(5).fill(40)])).toEqual([]); // too short
    const [spell] = run([40, ...Array(12).fill(62), 66, 40]);
    expect(spell).toMatchObject({ start: 1000, end: 13_000, peak: 66, limit: 50, road: "Road 1", open: false });
  });

  it("marks a spell still going at the end as open", () => {
    expect(run(Array(4).fill(70))).toMatchObject([{ open: true }]);
  });

  it("ends a spell at a gap in the data", () => {
    const points = [...Array(12).fill(70).map((k, s) => pt(s, 45, k)), ...Array(12).fill(70).map((k, s) => pt(200 + s, 45, k, 90, -75.01 + s * 0.0002))];
    expect(postedSpeedingSpells(matchToRoads(points, roads), 10).map((s) => [s.start, s.open])).toEqual([
      [0, false],
      [200_000, true],
    ]);
  });
});

describe("coverage", () => {
  it("splits distance into known limit, unknown limit and off-road", () => {
    const roads = [road(1, 45), road(2, 45.01, { limit: null })];
    // Ten seconds on each road (0.002° of longitude ≈ 157 m), with long gaps between (not counted).
    const at = (s: number, lat: number, lng: number) => pt(s, lat, 40, 90, lng);
    const points = [at(0, 45, -75.01), at(10, 45, -75.008), at(100, 45.01, -75.01), at(110, 45.01, -75.008), at(200, 45.02, -75.01), at(210, 45.02, -75.008)];
    const km = roadCoverageKm(matchToRoads(points, roads));
    expect(km.known).toBeCloseTo(0.157, 2);
    expect(km.unknown).toBeCloseTo(0.157, 2);
    expect(km.offRoad).toBeCloseTo(0.157, 2);
  });
});
