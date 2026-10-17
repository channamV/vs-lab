import type { CheckinEngine } from "@/lib/operators";
import { formatDistance } from "@/lib/format";

type FlaggableCheckin = {
  authorized: boolean;
  checklistOk: boolean;
  locationCheck: string | null;
  distanceM: number | null;
  engine: CheckinEngine;
};

/** Plain-language warnings for a check-in, shown on the Fleet and machine pages. */
export function checkinFlags(c: FlaggableCheckin): string[] {
  const flags: string[] = [];
  if (!c.authorized) flags.push("not approved");
  if (!c.checklistOk) flags.push("checklist issues");
  if (c.locationCheck === "far") flags.push(`not at machine (${formatDistance(c.distanceM)} away)`);
  if (c.locationCheck === "no-phone-location") flags.push("location not shared");
  if (c.engine.kind === "already-running") flags.push("engine running before check-in");
  return flags;
}

/** Short text for the "Engine" column. */
export function engineLabel(e: CheckinEngine): { text: string; warn: boolean } {
  switch (e.kind) {
    case "started":
      return { text: `Started ${e.minutes} min after`, warn: false };
    case "takeover":
      return { text: "Took over (shift change)", warn: false };
    case "already-running":
      return { text: "Already running", warn: true };
    case "waiting":
      return { text: "Waiting for start", warn: false };
    case "no-start":
      return { text: "No start", warn: false };
    case "not-used":
      return { text: "—", warn: false };
  }
}

/** Short text for the "At machine" column. */
export function locationLabel(c: { locationCheck: string | null; distanceM: number | null }): { text: string; warn: boolean } {
  switch (c.locationCheck) {
    case "near":
      return { text: `Yes (${formatDistance(c.distanceM)})`, warn: false };
    case "far":
      return { text: `No (${formatDistance(c.distanceM)})`, warn: true };
    case "no-phone-location":
      return { text: "Not shared", warn: true };
    case "no-machine-location":
      return { text: "Machine has no GPS fix", warn: false };
    default:
      return { text: "—", warn: false }; // check-ins made before the location check existed
  }
}
