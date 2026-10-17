import { describe, expect, it } from "vitest";
import { checkinFlags, engineLabel, locationLabel } from "./checkin-flags";

const clean = {
  authorized: true,
  checklistOk: true,
  locationCheck: "near",
  distanceM: 12,
  engine: { kind: "started", minutes: 4 } as const,
};

describe("checkinFlags", () => {
  it("has no flags for a clean check-in", () => {
    expect(checkinFlags(clean)).toEqual([]);
  });

  it("explains each problem in plain words", () => {
    expect(
      checkinFlags({
        authorized: false,
        checklistOk: false,
        locationCheck: "far",
        distanceM: 2300,
        engine: { kind: "already-running" },
      }),
    ).toEqual(["not approved", "checklist issues", "not at machine (2.3 km away)", "engine running before check-in"]);
    expect(checkinFlags({ ...clean, locationCheck: "no-phone-location" })).toEqual(["location not shared"]);
    // A shift-change takeover and an automatic "no start" check-out aren't problems
    expect(checkinFlags({ ...clean, engine: { kind: "takeover" } })).toEqual([]);
    expect(checkinFlags({ ...clean, engine: { kind: "no-start" } })).toEqual([]);
  });

  it("doesn't flag the operator when the machine has no GPS fix", () => {
    expect(checkinFlags({ ...clean, locationCheck: "no-machine-location", distanceM: null })).toEqual([]);
  });
});

describe("labels", () => {
  it("formats the history columns", () => {
    expect(locationLabel(clean)).toEqual({ text: "Yes (12 m)", warn: false });
    expect(locationLabel({ locationCheck: null, distanceM: null })).toEqual({ text: "—", warn: false });
    expect(engineLabel({ kind: "already-running" })).toEqual({ text: "Already running", warn: true });
    expect(engineLabel({ kind: "started", minutes: 4 })).toEqual({ text: "Started 4 min after", warn: false });
  });
});
