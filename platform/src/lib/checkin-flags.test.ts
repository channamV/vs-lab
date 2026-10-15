import { describe, expect, it } from "vitest";
import { checkinFlags, locationLabel, timingLabel } from "./checkin-flags";

const clean = {
  authorized: true,
  checklistOk: true,
  locationCheck: "near",
  distanceM: 12,
  timing: { kind: "on-time", minutes: 4 } as const,
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
        timing: { kind: "late", minutes: 180 },
      }),
    ).toEqual(["not approved", "checklist issues", "not at machine (2.3 km away)", "engine started 180 min after check-in"]);
    expect(checkinFlags({ ...clean, locationCheck: "no-phone-location", timing: { kind: "late", minutes: null } })).toEqual([
      "location not shared",
      "no engine start within 30 min",
    ]);
    expect(checkinFlags({ ...clean, timing: { kind: "already-running" } })).toEqual(["engine running before check-in"]);
  });

  it("doesn't flag the operator when the machine has no GPS fix", () => {
    expect(checkinFlags({ ...clean, locationCheck: "no-machine-location", distanceM: null })).toEqual([]);
  });
});

describe("labels", () => {
  it("formats the history columns", () => {
    expect(locationLabel(clean)).toEqual({ text: "Yes (12 m)", warn: false });
    expect(locationLabel({ locationCheck: null, distanceM: null })).toEqual({ text: "—", warn: false });
    expect(timingLabel({ kind: "late", minutes: null })).toEqual({ text: "No start", warn: true });
    expect(timingLabel({ kind: "on-time", minutes: 4 })).toEqual({ text: "4 min after", warn: false });
  });
});
