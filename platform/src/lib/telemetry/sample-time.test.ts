import { describe, expect, it } from "vitest";
import { gpsTimeToDate, sampleTimes } from "./sample-time";

const NOW = new Date("2026-10-25T14:53:20Z");

describe("gpsTimeToDate", () => {
  it("reads HHMMSScc as UTC today, or yesterday if that would be in the future", () => {
    expect(gpsTimeToDate(14520050, NOW)).toBe(Date.parse("2026-10-25T14:52:00.500Z"));
    const justAfterMidnight = new Date("2026-10-25T00:01:00Z");
    expect(gpsTimeToDate(23590000, justAfterMidnight)).toBe(Date.parse("2026-10-24T23:59:00Z")); // taken before midnight
    expect(gpsTimeToDate(100000, NOW)).toBeNull(); // 14 hours old: a bad clock, not a backlog
    expect(gpsTimeToDate(14580000, NOW)).toBe(Date.parse("2026-10-25T14:58:00Z")); // device a few minutes ahead: allowed
    expect(gpsTimeToDate(25000000, NOW)).toBeNull();
    expect(gpsTimeToDate(null, NOW)).toBeNull();
  });
});

describe("sampleTimes", () => {
  it("dates GPS readings by GPS time and the rest by uptime, never after arrival", () => {
    const times = sampleTimes(
      [
        { deviceMs: 600_000, gpsTime: 14530000 }, // newest, sent first
        { deviceMs: 590_000 }, // no fix: 10 s before it
        { deviceMs: 300_000, gpsTime: 14480000 }, // a backlog reading 5 minutes older
      ],
      NOW,
    );
    expect(times.map((t) => t.toISOString())).toEqual(["2026-10-25T14:53:00.000Z", "2026-10-25T14:52:50.000Z", "2026-10-25T14:48:00.000Z"]);
  });

  it("without GPS, takes the newest sample as now; without uptime, arrival time", () => {
    expect(sampleTimes([{ deviceMs: 5000 }, { deviceMs: 8000 }], NOW).map((t) => NOW.getTime() - t.getTime())).toEqual([3000, 0]);
    expect(sampleTimes([{ lat: 1 }], NOW)).toEqual([NOW]);
  });
});

describe("GPS date (our firmware, PID 0x11 DDMMYY)", () => {
  it("uses the date when it's plausible, even for readings days old", () => {
    expect(gpsTimeToDate(14520050, NOW, 251026)).toBe(Date.parse("2026-10-25T14:52:00.500Z"));
    expect(gpsTimeToDate(9000000, NOW, 221026)).toBe(Date.parse("2026-10-22T09:00:00Z")); // kept 3 days out of coverage
  });
  it("falls back to the time of day when the date is impossible, in the future or too old", () => {
    expect(gpsTimeToDate(14520050, NOW, 310226)).toBe(Date.parse("2026-10-25T14:52:00.500Z")); // 31 Feb
    expect(gpsTimeToDate(14520050, NOW, 10180)).toBe(Date.parse("2026-10-25T14:52:00.500Z")); // 2080
    expect(gpsTimeToDate(14520050, NOW, 10125)).toBe(Date.parse("2026-10-25T14:52:00.500Z")); // a year ago
  });
});

