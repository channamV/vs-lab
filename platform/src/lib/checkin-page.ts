import { currentMode } from "@/lib/mode-types";
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkins, engineSessions, machines, operators, organizations } from "@/lib/db/schema";
import { distanceMeters, isCheckinCurrent } from "@/lib/operators";
import { checklistForMachine, coveringChecklist } from "@/lib/checklists";
import { clockTime } from "@/lib/format";
import { photoStorageAvailable } from "@/lib/photos";
import { machineReadings, meterKindFor } from "@/lib/meters";
import { placeName } from "@/lib/places";
import type { ChecklistQuestion } from "@/lib/db/schema";

/** Written answers that start as the town and province ("Place of inspection"). */
export const isPlaceQuestion = (q: ChecklistQuestion) => Boolean(q.textOnly) && (q.prefill === "place" || q.id === "location");

/**
 * Data for the PUBLIC check-in page (/checkin/<machine>), which operators open by scanning the
 * QR sticker without signing in. Return only what that page shows: the machine's name, unit number,
 * whether it's locked out for repair, who is checked in, its checklist (questions, answers and
 * confirmation statement) and the privacy notice (organization name, privacy contact, how long data is kept). Everything else stays in src/lib/data.ts behind the admin session check.
 */
export async function getCheckinMachine(code: string) {
  await connection();
  const db = getDb();
  const [machine] = await db
    .select({
      id: machines.id,
      code: machines.code,
      name: machines.name,
      unitNumber: machines.unitNumber,
      organizationId: machines.organizationId,
      checklistTemplateId: machines.checklistTemplateId,
      lockedOutAt: machines.lockedOutAt,
      mode: machines.mode,
      modeUntil: machines.modeUntil,
      modeRevertTo: machines.modeRevertTo,
      tier: machines.tier,
      onRoad: machines.onRoad,
      lat: machines.lastLat,
      lng: machines.lastLng,
    })
    .from(machines)
    .where(eq(machines.code, code));
  if (!machine) return null;
  const [open] = await db
    .select({ checkin: checkins, operatorName: operators.name, linked: engineSessions })
    .from(checkins)
    .innerJoin(operators, eq(operators.id, checkins.operatorId))
    .leftJoin(engineSessions, eq(engineSessions.id, checkins.engineSessionId))
    .where(and(eq(checkins.machineId, machine.id), isNull(checkins.endedAt)));
  const current =
    open && isCheckinCurrent(open.checkin, open.linked, Date.now())
      ? { operatorName: open.operatorName, startedAt: open.checkin.startedAt, engineRunning: open.linked !== null }
      : null;
  const [{ template, options }, [org]] = await Promise.all([
    checklistForMachine(db, machine),
    db
      .select({
        name: organizations.name,
        privacyContact: organizations.privacyContact,
        locationDays: organizations.retainPhoneLocationDays,
        photoDays: organizations.retainPhotoDays,
        checkinDays: organizations.retainCheckinDays,
        timeZone: organizations.timezone,
      })
      .from(organizations)
      .where(eq(organizations.id, machine.organizationId)),
  ]);
  // Once a day per machine: today's checklist (its time only) covers everyone. Per operator, only the PIN can tell.
  const doneToday =
    template.frequency === "machine_daily"
      ? await coveringChecklist(db, { machineId: machine.id, frequency: template.frequency, timeZone: org.timeZone })
      : null;
  // The checklist's hour meter / odometer reading starts as the engine computer's own, when the device reads it.
  const meterKind = meterKindFor(machine);
  const readings = await machineReadings(db, machine.id);
  const reading = readings[meterKind];
  // "Place of inspection" answers start as the town where the machine is (the phone refines it on the page).
  const placeQuestionIds = template.sections.flatMap((s) => s.questions).filter(isPlaceQuestion).map((q) => q.id);
  const place = placeQuestionIds.length && machine.lat !== null && machine.lng !== null ? await placeName(db, machine.lat, machine.lng) : null;
  return {
    code: machine.code,
    name: machine.name,
    unitNumber: machine.unitNumber,
    lockedOut: machine.lockedOutAt !== null,
    /** Locked by a manager (not for repair): check-ins are refused. */
    locked: machine.lockedOutAt === null && currentMode(machine) === "locked",
    current,
    /** The company's time zone, for the "since" time. */
    timeZone: org.timeZone,
    privacy: { name: org.name, privacyContact: org.privacyContact, locationDays: org.locationDays, photoDays: org.photoDays, checkinDays: org.checkinDays },
    checklist: {
      sections: template.sections,
      options,
      confirmationText: template.confirmationText,
      photosEnabled: photoStorageAvailable(),
      frequency: template.frequency,
      /** Today's checklist time in the company's time zone ("7:02 AM"), or null. */
      doneTodayAt: doneToday ? clockTime(doneToday.startedAt, org.timeZone) : null,
      meter: {
        kind: meterKind,
        /** Filled in only from the engine computer; otherwise the last known reading is a hint. */
        value: reading?.source === "engine" ? reading.value : null,
        hint: reading && reading.source !== "engine" ? reading.value : null,
      },
      placeQuestionIds,
      place,
    },
  };
}

/** The phone's town and province, for a check-in page: only within 100 km of the machine (when its position is known). */
export async function placeNearMachine(db: ReturnType<typeof getDb>, code: string, lat: number, lng: number) {
  const [m] = await db.select({ lat: machines.lastLat, lng: machines.lastLng }).from(machines).where(eq(machines.code, code));
  if (!m) return null;
  if (m.lat !== null && m.lng !== null && distanceMeters({ lat: m.lat, lng: m.lng }, { lat, lng }) > 100_000) return null;
  return placeName(db, lat, lng);
}
