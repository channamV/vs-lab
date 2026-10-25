import { describe, expect, it } from "vitest";
import { parsePayload } from "@/lib/freematics/protocol";
import { detectEngine, engineStatus, hoursByDay, localDateKey, startOfLocalDay } from "./engine";

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

  it("reads a 24 V system (common on heavy equipment)", () => {
    expect(detectEngine({ batteryCentivolts: 2790 }).running).toBe(true);
    expect(detectEngine({ batteryCentivolts: 2520 }).running).toBe(false);
  });

  it("falls back to vibration: Telelogger sends acceleration with gravity removed", () => {
    // Real uploads from Y5725A32 sitting on a desk (2026-10-24), as the platform receives them.
    for (const raw of ["0:178812,20:0;0;0,82:32*A8", "0:153812,81:-89,20:0;0;0,82:32*E", "0:893723,20:0;0.01;0,82:38*42"]) {
      const { checksumValid, samples } = parsePayload(raw);
      expect(checksumValid).toBe(true);
      expect(detectEngine(samples[0])).toEqual({ running: false, source: "vibration" });
    }
    expect(detectEngine({ accel: [0.04, 0.03, 0.02] })).toEqual({ running: true, source: "vibration" });
  });

  it("returns unknown when there is nothing to go on", () => {
    expect(detectEngine({ lat: 43.6, lng: -79.4 })).toEqual({ running: null, source: null });
  });
});

describe("engineStatus", () => {
  const now = Date.parse("2026-10-24T23:00:00Z");
  const minutesAgo = (min: number) => new Date(now - min * 60_000);
  const machine = (state: { engineOn: boolean | null; lastSeen: number; unknownSince?: number }) => ({
    engineOn: state.engineOn,
    lastSeenAt: minutesAgo(state.lastSeen),
    engineUnknownSince: state.unknownSince === undefined ? null : minutesAgo(state.unknownSince),
  });

  it("shows the last state while the reports show it", () => {
    expect(engineStatus(machine({ engineOn: true, lastSeen: 1 }), now)).toBe("running");
    expect(engineStatus(machine({ engineOn: false, lastSeen: 1 }), now)).toBe("off");
    expect(engineStatus(machine({ engineOn: null, lastSeen: 1 }), now)).toBe("unknown");
  });

  it("marks a quiet running machine stale; a quiet parked one stays off", () => {
    expect(engineStatus(machine({ engineOn: true, lastSeen: 30 }), now)).toBe("stale");
    expect(engineStatus(machine({ engineOn: false, lastSeen: 30 }), now)).toBe("off");
  });

  it("shows unknown when the device keeps reporting but nothing has shown the engine state for over staleMinutes", () => {
    expect(engineStatus(machine({ engineOn: true, lastSeen: 1, unknownSince: 11 }), now)).toBe("unknown");
    expect(engineStatus(machine({ engineOn: false, lastSeen: 1, unknownSince: 11 }), now)).toBe("unknown");
    // Not long enough yet: keep showing the last state.
    expect(engineStatus(machine({ engineOn: true, lastSeen: 1, unknownSince: 5 }), now)).toBe("running");
    // Gone quiet altogether: the usual rules for a quiet device apply.
    expect(engineStatus(machine({ engineOn: true, lastSeen: 20, unknownSince: 40 }), now)).toBe("stale");
    expect(engineStatus(machine({ engineOn: false, lastSeen: 20, unknownSince: 40 }), now)).toBe("off");
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
