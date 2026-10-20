import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDb, migrateDb, type Db } from "@/lib/db";
import {
  alerts,
  auditLog,
  checkinPhotos,
  checkins,
  checklistIssues,
  devices,
  loginTokens,
  machineOperators,
  machines,
  notificationEvents,
  operators,
  organizations,
  telemetry,
} from "@/lib/db/schema";
import { raiseCheckinAlerts } from "@/lib/alerts";
import { DEFAULT_SECTIONS } from "@/lib/checklists";
import { checkIn, createOperator, setMachineOperators, updateOperator } from "@/lib/operators";
import { recordEvent } from "@/lib/notifications";
import { applyRetention, eraseOperator, exportOperator, PrivacyError, replaceName, updatePrivacySettings } from "./privacy";

let db: Db;
let org: number;
let machineId: number;
let janeId: number;
let photoDir: string;
const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));
const day = 86_400_000;
const t0 = new Date("2026-10-15T12:00:00Z");
const daysAfter = (d: number) => new Date(t0.getTime() + d * day);
const jpeg = { contentType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]) };

beforeEach(async () => {
  photoDir = mkdtempSync(path.join(tmpdir(), "vslab-privacy-"));
  process.env.PHOTO_DIR = photoDir;
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC", privacyContact: "privacy@abc.ie" }).returning();
  [{ id: machineId }] = await db
    .insert(machines)
    .values({ organizationId: org, code: "EXC14", name: "Excavator", unitNumber: "14", tier: "monitor", lastLat: 53.35, lastLng: -6.26 })
    .returning();
  ({ id: janeId } = await createOperator(db, org, { name: "Jane Doe", pin: "1111", employeeNumber: "E7" }));
  await setMachineOperators(db, org, machineId, [janeId]);
});

afterEach(() => {
  delete process.env.PHOTO_DIR;
  rmSync(photoDir, { recursive: true, force: true });
});

/** Jane checks in reporting a defect with a photo and her phone's location. */
async function janeChecksIn(at: Date) {
  const result = await checkIn(
    db,
    {
      machineCode: "EXC14",
      pin: "1111",
      answers: { ...allOk, seatbelt: "service_soon" },
      answerNotes: { seatbelt: "Jane Doe noticed the buckle sticks" },
      notes: "Checked by Jane Doe",
      confirmed: true,
      photos: [{ ...jpeg, questionId: "seatbelt" }],
      phoneLocation: { lat: 53.3501, lng: -6.2601, accuracyM: 10 },
    },
    at,
  );
  if (!result.ok) throw new Error(result.reason);
  await raiseCheckinAlerts(db, result.checkinId, at);
  return result.checkinId;
}

const photoFiles = async () => (await db.select().from(checkinPhotos)).map((p) => path.join(photoDir, p.storageKey));

describe("retention clean-up", () => {
  it("removes phone locations, photos, track data and old check-ins on each organization's schedule", async () => {
    const checkinId = await janeChecksIn(t0);
    await db.update(checkins).set({ endedAt: daysAfter(0.1) }).where(eq(checkins.id, checkinId));
    await db.insert(devices).values({ id: "DEV1" });
    await db.insert(telemetry).values([
      { deviceId: "DEV1", machineId, receivedAt: t0, fields: {} },
      { deviceId: "DEV1", machineId: null, receivedAt: t0, fields: {} },
    ]);
    const [file] = await photoFiles();
    expect(existsSync(file)).toBe(true);

    expect(await applyRetention(db, daysAfter(30))).toMatchObject({ phoneLocationsCleared: 0, photosDeleted: 0 });

    // After 90 days: the phone position goes, the near/far result stays.
    expect(await applyRetention(db, daysAfter(91))).toMatchObject({ phoneLocationsCleared: 1, photosDeleted: 0 });
    const [c] = await db.select().from(checkins);
    expect(c).toMatchObject({ phoneLat: null, phoneLng: null, phoneAccuracyM: null, locationCheck: "near" });

    // After a year: photos (file and record).
    expect(await applyRetention(db, daysAfter(366))).toMatchObject({ photosDeleted: 1, telemetryDeleted: 0, checkinsDeleted: 0 });
    expect(existsSync(file)).toBe(false);

    // After two years: the GPS track, including data from devices that weren't on a machine.
    expect(await applyRetention(db, daysAfter(731))).toMatchObject({ telemetryDeleted: 2, checkinsDeleted: 0 });

    // After three years: the check-in and its alerts. The open defect stays (the machine still needs the repair).
    expect(await applyRetention(db, daysAfter(1096))).toMatchObject({ checkinsDeleted: 1, alertsDeleted: 1, issuesDeleted: 0 });
    expect(await db.select().from(checklistIssues)).toHaveLength(1);
  });

  it("uses the organization's own settings, within limits", async () => {
    await expect(
      updatePrivacySettings(db, org, {
        privacyContact: "",
        retainPhoneLocationDays: 0,
        retainPhotoDays: 365,
        retainTelemetryDays: 730,
        retainCheckinDays: 1095,
        retainNotificationDays: 365,
      }),
    ).rejects.toThrow(/phone location at check-in: keep between 1 and 3650 days/);
    await updatePrivacySettings(db, org, {
      privacyContact: " dpo@abc.ie ",
      retainPhoneLocationDays: 7,
      retainPhotoDays: 30,
      retainTelemetryDays: 730,
      retainCheckinDays: 1095,
      retainNotificationDays: 365,
    });
    expect((await db.select().from(organizations).where(eq(organizations.id, org)))[0]).toMatchObject({ privacyContact: "dpo@abc.ie", retainPhoneLocationDays: 7, retainPhotoDays: 30 });
    await janeChecksIn(t0);
    expect(await applyRetention(db, daysAfter(31))).toMatchObject({ phoneLocationsCleared: 1, photosDeleted: 1 });
  });

  it("keeps a check-in that's still open, and tidies up sign-in records", async () => {
    await janeChecksIn(t0);
    await db.insert(loginTokens).values({ email: "a@b.c", tokenHash: "x", expiresAt: t0 });
    expect(await applyRetention(db, daysAfter(2000))).toMatchObject({ checkinsDeleted: 0 });
    expect(await db.select().from(checkins)).toHaveLength(1);
    expect(await db.select().from(loginTokens)).toEqual([]);
  });
});

describe("operator export", () => {
  it("includes the operator's check-ins, answers, location, photos and alerts, but not the PIN", async () => {
    await janeChecksIn(t0);
    const data = await exportOperator(db, org, janeId, daysAfter(1));
    expect(data).toMatchObject({
      organization: "ABC",
      privacyContact: "privacy@abc.ie",
      operator: { name: "Jane Doe", employeeNumber: "E7", approvedMachines: ["Unit 14 · Excavator"] },
      checkins: [
        {
          machine: "Unit 14 · Excavator",
          notes: "Checked by Jane Doe",
          phoneLocation: { lat: 53.3501, lng: -6.2601, accuracyM: 10 },
          photos: [{ question: "seatbelt", link: expect.stringMatching(/^\/photos\/\d+$/) }],
        },
      ],
      alerts: [{ type: "checklist-failed" }],
    });
    expect(JSON.stringify(data)).not.toContain((await db.select().from(operators))[0].pinHash);
    await expect(exportOperator(db, org + 1, janeId)).rejects.toBeInstanceOf(PrivacyError);
  });
});

describe("operator erasure", () => {
  it("removes personal data but keeps the machine's records under a placeholder", async () => {
    const checkinId = await janeChecksIn(t0);
    await db
      .update(machines)
      .set({ lockedOutAt: t0, lockedOutReason: "Jane Doe reported: seatbelt", lockedOutCheckinId: checkinId })
      .where(eq(machines.id, machineId));
    await recordEvent(db, { organizationId: org, machineId, type: "equipment_locked", operatorId: janeId, detail: "Locked by Jane Doe" });
    const files = await photoFiles();

    const result = await eraseOperator(db, org, janeId, daysAfter(1));
    expect(result).toEqual({ checkins: 1, photosDeleted: 1, placeholder: `Former operator #${janeId}` });

    const [op] = await db.select().from(operators);
    expect(op).toMatchObject({ name: `Former operator #${janeId}`, employeeNumber: null, active: false, erasedAt: daysAfter(1) });
    expect(op.pinHash).toMatch(/^erased:/);
    const [c] = await db.select().from(checkins);
    expect(c).toMatchObject({ phoneLat: null, phoneLng: null, notes: `Checked by Former operator #${janeId}`, endReason: "erased", locationCheck: "near" });
    expect(c.answers.find((a) => a.id === "seatbelt")?.note).toBe(`Former operator #${janeId} noticed the buckle sticks`);
    expect(await db.select().from(checkinPhotos)).toEqual([]);
    expect(files.some(existsSync)).toBe(false);
    const [alert] = await db.select().from(alerts);
    expect(alert.detail).toContain(`Former operator #${janeId} reported`);
    expect(alert.detail).not.toContain("Jane");
    expect((await db.select().from(checklistIssues))[0].note).not.toContain("Jane");
    expect((await db.select().from(machines))[0].lockedOutReason).toBe(`Former operator #${janeId} reported: seatbelt`);
    expect((await db.select().from(notificationEvents))[0].detail).toBe(`Locked by Former operator #${janeId}`);
    expect(await db.select().from(machineOperators)).toEqual([]);

    // The PIN no longer works, the operator can't be edited back, and it can't be erased twice.
    await db.update(machines).set({ lockedOutAt: null }).where(eq(machines.id, machineId));
    expect(await checkIn(db, { machineCode: "EXC14", pin: "1111", answers: allOk, confirmed: true }, daysAfter(2))).toMatchObject({
      ok: false,
      reason: "bad-pin",
    });
    await expect(updateOperator(db, org, janeId, { name: "Jane", active: true })).rejects.toThrow(/erased/);
    await expect(eraseOperator(db, org, janeId)).rejects.toThrow(/already/);
    // The PIN is free for someone else.
    await createOperator(db, org, { name: "Sam", pin: "1111" });
  });

  it("only replaces the name as a whole word", () => {
    expect(replaceName("Al reported; Alan and Al's", "Al", "X")).toBe("X reported; Alan and X's");
    expect(replaceName("Seán Ó Briain (S.Ó.B.)", "Seán Ó Briain", "Former operator #3")).toBe("Former operator #3 (S.Ó.B.)");
    expect(replaceName(null, "Al", "X")).toBeNull();
  });
});

describe("audit log", () => {
  it("records staff opening an organization", async () => {
    const { viewOrganization } = await import("@/lib/auth");
    const [home] = await db.insert(organizations).values({ name: "Veristart" }).returning();
    await viewOrganization(
      db,
      { sessionId: 0, userId: 0, email: "staff@veristart.ca", name: null, role: "owner", isPlatformAdmin: true, homeOrganizationId: home.id, organizationId: home.id, organizationName: "Veristart", divisionIds: null },
      org,
    );
    expect(await db.select().from(auditLog)).toMatchObject([{ organizationId: org, actor: "staff@veristart.ca", staff: true, action: "staff-view" }]);
  });
});
