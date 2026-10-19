import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, checkins, checklistAnswerSets, checklistIssues, checklistTemplates, machines, organizations, users } from "@/lib/db/schema";
import { raiseCheckinAlerts } from "@/lib/alerts";
import { checkIn, createOperator } from "@/lib/operators";
import {
  checklistForMachine,
  clearLockout,
  createAnswerSet,
  createTemplate,
  deleteAnswerSet,
  deleteTemplate,
  DEFAULT_SECTIONS,
  ensureChecklistDefaults,
  evaluateAnswers,
  resolveIssue,
  setDefaultTemplate,
  setMachineTemplate,
  updateTemplate,
} from "./checklists";

let db: Db;
let org: number;
let machineId: number;
const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));
const at = (min: number) => new Date(Date.parse("2026-10-15T12:00:00Z") + min * 60_000);
const machine = async () => (await db.select().from(machines).where(eq(machines.id, machineId)))[0];
/** The check-in's "Repair needed" alerts (check-ins here also raise "not at machine": no phone location). */
const repairAlerts = async (checkinId: number) => (await raiseCheckinAlerts(db, checkinId)).filter((a) => a.type === "checklist-failed");
const openIssues = () => db.select().from(checklistIssues).orderBy(checklistIssues.id);

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
  [{ id: machineId }] = await db
    .insert(machines)
    .values({ organizationId: org, code: "EXC14", name: "Excavator", unitNumber: "14", tier: "monitor" })
    .returning();
  await createOperator(db, org, { name: "Jane", pin: "1111" });
});

const checkInWith = (answers: Record<string, string>, extra: Partial<Parameters<typeof checkIn>[1]> = {}, min = 0) =>
  checkIn(db, { machineCode: "EXC14", pin: "1111", answers: { ...allOk, ...answers }, confirmed: true, ...extra }, at(min));

describe("defaults", () => {
  it("gives each organization the two answer sets and a default checklist with the original questions", async () => {
    await ensureChecklistDefaults(db, org);
    await ensureChecklistDefaults(db, org); // safe to repeat
    const sets = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.organizationId, org));
    expect(sets.map((s) => [s.name, s.options.map((o) => o.label)])).toEqual([
      ["Standard", ["OK", "Service soon", "Lockout", "Not applicable"]],
      ["Vehicle inspection", ["OK", "Minor defect", "Major defect", "Not applicable"]],
    ]);
    const { template, options } = await checklistForMachine(db, await machine());
    expect(template).toMatchObject({ name: "Standard pre-start", isDefault: true });
    expect(template.sections.flatMap((s) => s.questions)).toHaveLength(10);
    expect(options[0]).toMatchObject({ key: "ok", severity: "pass" });
  });
});

describe("answering", () => {
  const sections = [{ id: "s", title: "Cab", questions: [{ id: "belt", text: "Seatbelt", noteRequired: true }, { id: "horn", text: "Horn", noteRequired: false }] }];
  const options = [
    { key: "ok", label: "OK", severity: "pass" as const, color: "#059669" },
    { key: "minor", label: "Minor defect", severity: "minor" as const, color: "#d97706" },
    { key: "major", label: "Major defect", severity: "major" as const, color: "#dc2626" },
    { key: "na", label: "N/A", severity: "na" as const, color: "#64748b" },
  ];

  it("records the question and answer text, and finds defects", () => {
    const result = evaluateAnswers(sections, options, { answers: { belt: "major", horn: "na" }, notes: { belt: " frayed " } });
    expect(result).toMatchObject({
      ok: true,
      hasMajor: true,
      answers: [
        { id: "belt", question: "Seatbelt", section: "Cab", answer: "Major defect", severity: "major", ok: false, note: "frayed" },
        { id: "horn", question: "Horn", answer: "N/A", severity: "na", ok: true },
      ],
      defects: [{ questionId: "belt", severity: "major", answerLabel: "Major defect", note: "frayed" }],
    });
  });

  it("needs every question answered, and a note where the template asks for one", () => {
    expect(evaluateAnswers(sections, options, { answers: { belt: "ok" } })).toMatchObject({ ok: false, reason: "incomplete", questions: ["Horn"] });
    expect(evaluateAnswers(sections, options, { answers: { belt: "minor", horn: "ok" } })).toMatchObject({ ok: false, reason: "note-required" });
    expect(evaluateAnswers(sections, options, { answers: { belt: "bogus", horn: "ok" } })).toMatchObject({ ok: false, reason: "incomplete" });
  });

  it("requires the confirmation statement, unless the machine is being locked out", async () => {
    expect(await checkInWith({}, { confirmed: false })).toEqual({ ok: false, reason: "not-confirmed" });
    // Lockout without a major defect is ignored, so the confirmation is still needed.
    expect(await checkInWith({ seatbelt: "service_soon" }, { confirmed: false, lockout: true })).toEqual({ ok: false, reason: "not-confirmed" });
    expect(await checkInWith({ seatbelt: "lockout" }, { confirmed: false, lockout: true })).toMatchObject({ ok: true, lockedOut: true });
  });
});

describe("issues stack", () => {
  it("opens an issue per defect, stacks repeats without new alerts, and alerts again when escalated", async () => {
    const first = await checkInWith({ seatbelt: "service_soon", lights: "service_soon" }, {}, 0);
    if (!first.ok) throw new Error("check-in failed");
    expect((await repairAlerts(first.checkinId)).map((a) => a.title)).toEqual(["Repair needed: Unit 14 · Excavator"]);

    // The next operator reports the seatbelt again: same issue, count 2, no new alert.
    const repeat = await checkInWith({ seatbelt: "service_soon" }, {}, 60);
    if (!repeat.ok) throw new Error("check-in failed");
    expect(await repairAlerts(repeat.checkinId)).toEqual([]);
    let issues = await openIssues();
    expect(issues.map((i) => [i.questionId, i.severity, i.reportCount]).sort()).toEqual([
      ["lights", "minor", 1],
      ["seatbelt", "minor", 2],
    ]);

    // Reported as a major defect: escalated, alerted.
    const worse = await checkInWith({ seatbelt: "lockout" }, { lockout: false }, 120);
    if (!worse.ok) throw new Error("check-in failed");
    const [alert] = await repairAlerts(worse.checkinId);
    expect(alert.detail).toContain("Seatbelt in good condition and working (Lockout, now major)");
    expect(alert.detail).toContain("1 other open issue on this machine.");
    issues = await openIssues();
    expect(issues.find((i) => i.questionId === "seatbelt")).toMatchObject({ severity: "major", reportCount: 3 });
    expect(await db.select().from(alerts).where(eq(alerts.type, "checklist-failed"))).toHaveLength(2);
  });

  it("opens a fresh issue once the old one is resolved", async () => {
    await checkInWith({ seatbelt: "service_soon" }, {}, 0);
    const [issue] = await openIssues();
    const [mechanic] = await db.insert(users).values({ organizationId: org, email: "m@abc.com", role: "manager" }).returning();
    await resolveIssue(db, org, issue.id, mechanic.id, " replaced buckle ", at(10));
    expect((await openIssues())[0]).toMatchObject({ resolvedAt: at(10), resolvedByUserId: mechanic.id, resolutionNote: "replaced buckle" });
    const again = await checkInWith({ seatbelt: "service_soon" }, {}, 60);
    if (!again.ok) throw new Error("check-in failed");
    expect((await openIssues()).map((i) => [i.reportCount, i.resolvedAt !== null])).toEqual([
      [1, true],
      [1, false],
    ]);
    expect(await repairAlerts(again.checkinId)).toHaveLength(1);
  });
});

describe("lockout", () => {
  it("locks the machine out after a major defect, ends the check-in, and blocks check-ins until cleared", async () => {
    const result = await checkInWith({ controls: "lockout" }, { confirmed: false, lockout: true }, 0);
    expect(result).toMatchObject({ ok: true, lockedOut: true, failedItems: ["Controls and safety lockout lever working (Lockout)"] });
    expect(await machine()).toMatchObject({ lockedOutAt: at(0), lockedOutReason: "Jane reported: Controls and safety lockout lever working" });
    const [row] = await db.select().from(checkins);
    expect(row).toMatchObject({ lockoutRequested: true, endedAt: at(0), endReason: "locked out", confirmationText: null });
    if (!result.ok) throw new Error();
    const [alert] = await repairAlerts(result.checkinId);
    expect(alert.detail).toContain("The machine has been locked out for repair.");

    expect(await checkInWith({}, {}, 5)).toEqual({ ok: false, reason: "machine-locked-out" });
    await clearLockout(db, org, machineId);
    expect(await checkInWith({}, {}, 10)).toMatchObject({ ok: true, lockedOut: false });
  });
});

describe("templates and answer sets", () => {
  it("assigns templates per machine, with the organization default for the rest", async () => {
    await ensureChecklistDefaults(db, org);
    const [vehicle] = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.name, "Vehicle inspection"));
    const pickup = await createTemplate(db, org, {
      name: "Pickup truck",
      answerSetId: vehicle.id,
      confirmationText: "I certify this vehicle was inspected as required by NSC Standard 13.",
      sections: [{ title: "Exterior", questions: [{ text: "Tires and wheels" }, { text: "Lamps" }] }],
    });
    expect(pickup.sections).toEqual([
      { id: "exterior", title: "Exterior", questions: [{ id: "tires_and_wheels", text: "Tires and wheels", noteRequired: false }, { id: "lamps", text: "Lamps", noteRequired: false }] },
    ]);
    await setMachineTemplate(db, org, machineId, pickup.id);
    const result = await checkIn(db, { machineCode: "EXC14", pin: "1111", answers: { tires_and_wheels: "minor_defect", lamps: "ok" }, confirmed: true }, at(0));
    expect(result).toMatchObject({ ok: true, failedItems: ["Tires and wheels (Minor defect)"] });
    const [row] = await db.select().from(checkins);
    expect(row).toMatchObject({ templateName: "Pickup truck", confirmationText: "I certify this vehicle was inspected as required by NSC Standard 13." });

    // Renaming a question keeps its id (so repeat reports still stack); past check-ins keep the old text.
    await updateTemplate(db, org, pickup.id, {
      name: "Pickup truck",
      answerSetId: vehicle.id,
      confirmationText: "Inspected.",
      sections: [{ id: "exterior", title: "Exterior", questions: [{ id: "tires_and_wheels", text: "Tires, wheels and rims" }, { id: "lamps", text: "Lamps" }] }],
    });
    expect((await db.select().from(checkins))[0].answers[0].question).toBe("Tires and wheels");
    await checkIn(db, { machineCode: "EXC14", pin: "1111", answers: { tires_and_wheels: "minor_defect", lamps: "ok" }, confirmed: true }, at(60));
    expect((await openIssues()).map((i) => [i.question, i.reportCount])).toEqual([["Tires, wheels and rims", 2]]);

    // The default can't be deleted; deleting another puts its machines back on the default.
    const [standard] = await db.select().from(checklistTemplates).where(eq(checklistTemplates.isDefault, true));
    await expect(deleteTemplate(db, org, standard.id)).rejects.toThrow(/default/);
    await deleteTemplate(db, org, pickup.id);
    expect((await machine()).checklistTemplateId).toBeNull();
    await expect(deleteAnswerSet(db, org, (await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.name, "Standard")))[0].id)).rejects.toThrow(/uses this answer set/);
  });

  it("validates templates and answer sets, and switches the default", async () => {
    await ensureChecklistDefaults(db, org);
    const [set] = await db.select().from(checklistAnswerSets).limit(1);
    const base = { name: "T", answerSetId: set.id, confirmationText: "Safe.", sections: [{ title: "A", questions: [{ text: "Q" }] }] };
    await expect(createTemplate(db, org, { ...base, sections: [{ title: "A", questions: [{ text: " " }] }] })).rejects.toThrow(/at least one question/);
    await expect(createTemplate(db, org, { ...base, confirmationText: " " })).rejects.toThrow(/confirmation/);
    await expect(createTemplate(db, org, { ...base, name: "Standard pre-start" })).rejects.toThrow(/already/);
    const [other] = await db.insert(organizations).values({ name: "XYZ" }).returning();
    await expect(createTemplate(db, other.id, base)).rejects.toThrow(/Choose an answer set/);
    const t = await createTemplate(db, org, base);
    await setDefaultTemplate(db, org, t.id);
    const defaults = await db.select().from(checklistTemplates).where(eq(checklistTemplates.isDefault, true));
    expect(defaults.filter((r) => r.organizationId === org).map((r) => r.id)).toEqual([t.id]);

    await expect(createAnswerSet(db, org, { name: "Bad", options: [{ label: "Broken", severity: "major" }, { label: "Bent", severity: "minor" }] })).rejects.toThrow(/means OK/);
    await expect(createAnswerSet(db, org, { name: "Bad", options: [{ label: "OK", severity: "pass" }] })).rejects.toThrow(/at least two/);
    const custom = await createAnswerSet(db, org, {
      name: "Pass / fail",
      options: [{ label: "Pass", severity: "pass" }, { label: "Fail", severity: "major", color: "#000000" }],
    });
    expect(custom.options).toEqual([
      { key: "pass", label: "Pass", severity: "pass", color: "#059669" },
      { key: "fail", label: "Fail", severity: "major", color: "#000000" },
    ]);
  });
});
