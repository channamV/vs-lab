import { CHECKIN_RULES, type CheckinTiming } from "@/lib/operators";
import { formatDistance } from "@/lib/format";

type FlaggableCheckin = {
  authorized: boolean;
  checklistOk: boolean;
  locationCheck: string | null;
  distanceM: number | null;
  timing: CheckinTiming;
};

/** Plain-language warnings for a check-in, shown on the Fleet and machine pages. */
export function checkinFlags(c: FlaggableCheckin): string[] {
  const flags: string[] = [];
  if (!c.authorized) flags.push("not approved");
  if (!c.checklistOk) flags.push("checklist issues");
  if (c.locationCheck === "far") flags.push(`not at machine (${formatDistance(c.distanceM)} away)`);
  if (c.locationCheck === "no-phone-location") flags.push("location not shared");
  if (c.timing.kind === "late") {
    flags.push(
      c.timing.minutes === null
        ? `no engine start within ${CHECKIN_RULES.engineStartWindowMinutes} min`
        : `engine started ${c.timing.minutes} min after check-in`,
    );
  }
  if (c.timing.kind === "already-running") flags.push("engine running before check-in");
  return flags;
}

/** Short text for the "Engine start" column. */
export function timingLabel(t: CheckinTiming): { text: string; warn: boolean } {
  switch (t.kind) {
    case "on-time":
      return { text: `${t.minutes} min after`, warn: false };
    case "waiting":
      return { text: "Waiting", warn: false };
    case "not-used":
      return { text: "Not used", warn: false };
    case "already-running":
      return { text: "Before check-in", warn: true };
    case "late":
      return { text: t.minutes === null ? "No start" : `${t.minutes} min after`, warn: true };
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
