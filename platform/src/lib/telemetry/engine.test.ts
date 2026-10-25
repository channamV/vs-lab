import { describe, expect, it } from "vitest";
import { detectEngine, hoursByDay, localDateKey, startOfLocalDay } from "./engine";

const TZ = "America/Toronto";

describe("detectEngine", () => {
  it("uses RPM when the machine reports it", () => {
    expect(detectEngine({ obdRpm: 850, batteryCentivolts: 1250 })).toEqual({ running: true, source: "rpm" });
    expect(detectEngine({ obdRpm: 0, batteryCentivolts: 1420 })).toEqual({ running: false, source: "rpm" });
  });

  it("reads a 12 V system", () => {
    expect(detectEngine({ batteryCentivolts: 1390 }).running).toBe(true);
    expect(detectEngine({ batteryCentivolts: 1260 }).running).toBe(false);
  });

  it("ignores supply readings from USB or a bench supply (below 8 V)", () => {
    // Y5725A32 on a desk, on USB power (2026-10-24): 361–369 cV.
    for (const cv of [361, 365, 369]) {
      expect(detectEngine({ batteryCentivolts: cv })).toEqual({ running: null, source: null });
      expect(detectEngine({ batteryCentivolts: cv, accel: [0, 0, 0] }).source).toBe("vibration");
    }
    expect(detectEngine({ batteryCentivolts: 799 }).source).toBeNull();
    expect(detectEngine({ batteryCentivolts: 800 })).toEqual({ running: false, source: "voltage" });
  });

  it("reads a 24 V system (common on heavy equipment)", () => {
    expect(detectEngine({ batteryCentivolts: 2790 }).running).toBe(true);
    expect(detectEngine({ batteryCentivolts: 2520 }).running).toBe(false);
  });

  it("falls back to vibration", () => {
    expect(detectEngine({ accel: [0.04, 0.03, 1.08] })).toEqual({ running: true, source: "vibration" });
    expect(detectEngine({ accel: [0, 0.01, 1] })).toEqual({ running: false, source: "vibration" });
  });

  it("returns unknown when there is nothing to go on", () => {
    expect(detectEngine({ lat: 43.6, lng: -79.4 })).toEqual({ running: null, source: null });
  });
});

describe("local days", () => {
  it("finds local midnight in Toronto (UTC-4 in October)", () => {
    const now = Date.parse("2026-10-15T15:00:00Z"); // 11:00 local
    expect(new Date(startOfLocalDay(now, TZ)).toISOString()).toBe("2026-10-15T04:00:00.000Z");
    expect(new Date(startOfLocalDay(now, TZ, 1)).toISOString()).toBe("2026-10-14T04:00:00.000Z");
  });

  it("handles the daylight-saving change", () => {
    const now = Date.parse("2026-11-02T15:00:00Z"); // clocks went back Nov 1
    expect(new Date(startOfLocalDay(now, TZ)).toISOString()).toBe("2026-11-02T05:00:00.000Z");
    expect(new Date(startOfLocalDay(now, TZ, 2)).toISOString()).toBe("2026-10-31T04:00:00.000Z");
  });

  it("labels dates in local time", () => {
    // 01:00 UTC on the 16th is still the 15th in Toronto
    expect(localDateKey(Date.parse("2026-10-16T01:00:00Z"), TZ)).toBe("2026-10-15");
  });
});

describe("hoursByDay", () => {
  const now = Date.parse("2026-10-15T20:00:00Z"); // 16:00 local
  const d = (iso: string) => new Date(iso);

  it("splits a session across local midnight", () => {
    // 22:00 → 02:00 local
    const days = hoursByDay(
      [{ startedAt: d("2026-10-15T02:00:00Z"), endedAt: d("2026-10-15T06:00:00Z"), lastSeenAt: d("2026-10-15T06:00:00Z") }],
      now,
      2,
      TZ,
    );
    expect(days).toEqual([
      { date: "2026-10-14", hours: 2 },
      { date: "2026-10-15", hours: 2 },
    ]);
  });

  it("counts an open session up to now", () => {
    const [today] = hoursByDay(
      [{ startedAt: d("2026-10-15T18:30:00Z"), endedAt: null, lastSeenAt: d("2026-10-15T19:59:00Z") }],
      now,
      1,
      TZ,
    );
    expect(today.hours).toBeCloseTo(1.5);
  });

  it("stops counting an open session when the device went silent", () => {
    const [today] = hoursByDay(
      [{ startedAt: d("2026-10-15T16:00:00Z"), endedAt: null, lastSeenAt: d("2026-10-15T17:00:00Z") }],
      now,
      1,
      TZ,
    );
    expect(today.hours).toBeCloseTo(1);
  });
});
