import { currentMode } from "@/lib/mode-types";
import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { connection } from "next/server";
import { getDb } from "@/lib/db";
import { checkins, engineSessions, machines, operators, organizations } from "@/lib/db/schema";
import { isCheckinCurrent } from "@/lib/operators";
import { checklistForMachine, coveringChecklist } from "@/lib/checklists";
import { clockTime } from "@/lib/format";
import { photoStorageAvailable } from "@/lib/photos";

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
    },
  };
}
