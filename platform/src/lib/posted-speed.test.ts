import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, machines, notificationEvents, organizations, roadCoverage, roadTiles, safetyEvents, telemetry } from "@/lib/db/schema";
import { createMachine, pairDevice } from "@/lib/machines";
import { checkPostedSpeeds, POSTED_RULES } from "./posted-speed";

const T0 = Date.parse("2026-10-20T15:00:00Z");
const NOW = new Date(T0 + 60 * 60_000);
/** Overpass answer: one east–west road at lat 45.02 with a 50 km/h limit. */
const overpass = () =>
  vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        elements: [
          { id: 1, tags: { highway: "primary", name: "Main St", maxspeed: "50" }, geometry: [{ lat: 45.02, lon: -75.03 }, { lat: 45.02, lon: -75.0 }] },
          { id: 2, tags: { highway: "footway" }, geometry: [{ lat: 45.02, lon: -75.03 }, { lat: 45.021, lon: -75.0 }] },
        ],
      }),
    ),
  );

let db: Db;
let org: number;
let machineId: number;
beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC", postedLimitTolerancePct: 10 }).returning();
  ({ id: machineId } = await createMachine(db, org, { name: "Pickup", onRoad: true }));
  await db.insert(devices).values({ id: "DEV1", organizationId: org });
  await pairDevice(db, "DEV1", machineId, new Date(T0 - 3_600_000));
  await db.update(machines).set({ roadCheckedUntil: new Date(T0) }).where(eq(machines.id, machineId));
});

/** Driving east along Main St, one reading a second from `startS` seconds after T0. */
async function drive(startS: number, speeds: number[]) {
  await db.insert(telemetry).values(
    speeds.map((kph, i) => ({
      deviceId: "DEV1",
      machineId,
      receivedAt: new Date(T0 + (startS + i) * 1000),
      lat: 45.02,
      lng: -75.025 + (startS + i) * 0.0002,
      speedKph: kph,
      heading: 90,
      satellites: 9,
      fields: {},
    })),
  );
}

describe("checkPostedSpeeds", () => {
  it("records a spell over the posted limit, notifies, tallies km, and caches the map", async () => {
    await drive(0, [40, 40, ...Array(15).fill(64), 40, 40, 40]);
    const fetch = overpass();
    expect(await checkPostedSpeeds(db, NOW, fetch)).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][1].body)).toContain(encodeURIComponent("(45,-75.05,45.05,-75)"));

    const [event] = await db.select().from(safetyEvents);
    expect(event).toMatchObject({ kind: "posted_speeding", peak: 64, limitValue: 50, machineId });
    expect(event.detail).toBe("64 km/h in a 50 km/h zone on Main St (posted limit + 10% tolerance; OpenStreetMap).");
    expect((await db.select().from(notificationEvents)).map((e) => e.type)).toEqual(["posted_speeding"]);
    const [coverage] = await db.select().from(roadCoverage);
    expect(coverage).toMatchObject({ organizationId: org, month: "2026-10" });
    expect(coverage.knownKm).toBeGreaterThan(0.25);
    expect(coverage.unknownKm).toBe(0);

    // Next run: nothing new, map from the cache.
    const again = overpass();
    expect(await checkPostedSpeeds(db, new Date(NOW.getTime() + 5 * 60_000), again)).toBe(0);
    expect(again).not.toHaveBeenCalled();
    expect(await db.select().from(safetyEvents)).toHaveLength(1);
  });

  it("waits for a spell still going at the end, then records it whole", async () => {
    await drive(0, [40, ...Array(12).fill(70)]);
    const at = new Date(T0 + 4 * 60_000 + 13_000); // the settle time just covers the readings
    expect(await checkPostedSpeeds(db, at, overpass())).toBe(0);
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m.roadCheckedUntil?.getTime()).toBe(T0 + 1000);
    await drive(13, [...Array(8).fill(72), 40, 40]);
    expect(await checkPostedSpeeds(db, NOW, overpass())).toBe(1);
    const [event] = await db.select().from(safetyEvents);
    expect([event.startedAt.getTime(), event.endedAt?.getTime(), event.peak]).toEqual([T0 + 1000, T0 + 20_000, 72]);
  });

  it("does nothing for companies without a tolerance or machines that aren't on-road", async () => {
    await drive(0, Array(20).fill(90));
    await db.update(machines).set({ onRoad: false }).where(eq(machines.id, machineId));
    const fetch = overpass();
    expect(await checkPostedSpeeds(db, NOW, fetch)).toBe(0);
    await db.update(machines).set({ onRoad: true }).where(eq(machines.id, machineId));
    await db.update(organizations).set({ postedLimitTolerancePct: null });
    expect(await checkPostedSpeeds(db, NOW, fetch)).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("waits when the map can't be downloaded, without losing data", async () => {
    await drive(0, Array(20).fill(90));
    const down = vi.fn().mockResolvedValue(new Response("busy", { status: 429 }));
    expect(await checkPostedSpeeds(db, NOW, down)).toBe(0);
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m.roadCheckedUntil?.getTime()).toBe(T0);
    expect(await db.select().from(roadTiles)).toHaveLength(0);
    expect(await checkPostedSpeeds(db, NOW, overpass())).toBe(1);
  });

  it("checks at most a few hours per run for a machine that's behind", async () => {
    await db.update(machines).set({ roadCheckedUntil: new Date(T0 - 24 * 3_600_000) }).where(eq(machines.id, machineId));
    await checkPostedSpeeds(db, NOW, overpass());
    const [m] = await db.select().from(machines).where(eq(machines.id, machineId));
    expect(m.roadCheckedUntil?.getTime()).toBe(T0 - (24 - POSTED_RULES.maxWindowHours) * 3_600_000);
  });
});
