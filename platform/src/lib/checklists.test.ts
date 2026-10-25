import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, checkinPhotos, checkins, checklistAnswerSets, checklistIssues, checklistTemplates, machines, organizations, users } from "@/lib/db/schema";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { raiseCheckinAlerts } from "@/lib/alerts";
import { readPhoto } from "@/lib/photos";
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
import { addLibraryTemplate, CHECKLIST_LIBRARY } from "./checklist-library";

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
      {
        id: "exterior",
        title: "Exterior",
        questions: [
          { id: "tires_and_wheels", text: "Tires and wheels", noteRequired: false, photoRequired: false, photoOnly: false },
          { id: "lamps", text: "Lamps", noteRequired: false, photoRequired: false, photoOnly: false },
        ],
      },
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

describe("photos", () => {
  const sections = [
    {
      id: "walk",
      title: "Walk-around",
      questions: [
        { id: "front", text: "Photo of front", noteRequired: false, photoOnly: true, photoRequired: true },
        { id: "tires", text: "Tires", noteRequired: false, photoRequired: true },
        { id: "horn", text: "Horn", noteRequired: false },
      ],
    },
  ];
  const options = [
    { key: "ok", label: "OK", severity: "pass" as const, color: "#059669" },
    { key: "bad", label: "Major defect", severity: "major" as const, color: "#dc2626" },
  ];

  it("needs required photos, and photo-only steps need no answer", () => {
    const answers = { tires: "ok", horn: "ok" };
    expect(evaluateAnswers(sections, options, { answers, photoCounts: { tires: 1 } })).toMatchObject({
      ok: false,
      reason: "photo-required",
      questions: ["Photo of front"],
    });
    const ok = evaluateAnswers(sections, options, { answers, photoCounts: { front: 1, tires: 2 } });
    expect(ok).toMatchObject({ ok: true, answers: [{ id: "front", photoOnly: true, answer: "Photo taken", ok: true }, { id: "tires" }, { id: "horn" }] });
    // Without photo storage, required photos aren't enforced (so check-ins still work).
    expect(evaluateAnswers(sections, options, { answers, enforcePhotos: false })).toMatchObject({ ok: true });
  });

  it("stores photos with the check-in, only for the machine's checklist questions", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "vslab-photos-"));
    process.env.PHOTO_DIR = dir;
    try {
      const jpeg = { contentType: "image/jpeg", data: new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3]) };
      expect(await checkInWith({}, { photos: [{ ...jpeg, questionId: "not-a-question" }] })).toEqual({ ok: false, reason: "photo-invalid" });
      expect(await checkInWith({}, { photos: [{ questionId: "seatbelt", contentType: "text/html", data: new Uint8Array([1]) }] })).toEqual({ ok: false, reason: "photo-invalid" });
      const four = Array.from({ length: 4 }, () => ({ ...jpeg, questionId: "seatbelt" }));
      expect(await checkInWith({}, { photos: four })).toEqual({ ok: false, reason: "photo-invalid" });

      const result = await checkInWith({ seatbelt: "service_soon" }, { photos: [{ ...jpeg, questionId: "seatbelt" }, { ...jpeg, questionId: "lights" }] });
      expect(result).toMatchObject({ ok: true });
      const rows = await db.select().from(checkinPhotos).orderBy(checkinPhotos.id);
      expect(rows.map((r) => [r.questionId, r.contentType, r.bytes])).toEqual([
        ["seatbelt", "image/jpeg", 6],
        ["lights", "image/jpeg", 6],
      ]);
      expect(await readPhoto(rows[0].storageKey)).toEqual(jpeg.data);
      expect(rows[0].storageKey).toMatch(/^org-\d+\/\d{4}-\d{2}-\d{2}\/[0-9a-f]{24}\.jpg$/);
    } finally {
      delete process.env.PHOTO_DIR;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ready-made checklists", () => {
  it("adds the NL Schedule A trip inspection with written answers for location, odometer and trailer", async () => {
    const nl = await addLibraryTemplate(db, org, "nl-trip-inspection-schedule-a");
    const questions = nl.sections.flatMap((s) => s.questions);
    // All 23 Schedule A systems, each needing a description when a defect is reported.
    const parts = questions.filter((q) => /^\d+\. /.test(q.text));
    expect(parts.map((q) => Number(q.text.split(".")[0])).sort((a, b) => a - b)).toEqual(Array.from({ length: 23 }, (_, i) => i + 1));
    expect(parts.every((q) => q.noteRequired && q.text.length <= 300)).toBe(true);
    expect(questions.filter((q) => q.textOnly).map((q) => q.id)).toEqual(["location", "odometer", "trailers"]);
    const [set] = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.id, nl.answerSetId));
    expect(set.name).toBe("Vehicle inspection");
    await expect(addLibraryTemplate(db, org, "nl-trip-inspection-schedule-a")).rejects.toThrow(/already/);

    await setMachineTemplate(db, org, machineId, nl.id);
    const answers = Object.fromEntries(parts.map((q) => [q.id, q.id === "p08_electric_brakes" ? "na" : "ok"]));
    const missing = await checkIn(db, { machineCode: "EXC14", pin: "1111", answers, answerNotes: { location: "Route 1, Whitbourne" }, confirmed: true }, at(0));
    expect(missing).toMatchObject({ ok: false, reason: "incomplete" });
    const ok = await checkIn(
      db,
      {
        machineCode: "EXC14",
        pin: "1111",
        answers: { ...answers, p21_tires: "minor_defect" },
        answerNotes: { location: "Route 1, Whitbourne", odometer: "184 220", trailers: "None", p21_tires: "Right rear outer: cut in sidewall" },
        confirmed: true,
      },
      at(5),
    );
    expect(ok).toMatchObject({ ok: true });
    const [row] = await db.select().from(checkins);
    expect(row.answers.filter((a) => a.textOnly).map((a) => [a.question, a.answer])).toEqual([
      ["Place of inspection (city, town or highway)", "Route 1, Whitbourne"],
      ["Odometer reading (km)", "184 220"],
      ["Trailer(s) towed: licence plate or unit number (write \"None\" if not towing)", "None"],
    ]);
    expect((await openIssues()).map((i) => i.questionId)).toEqual(["p21_tires"]);
  });

  it("creates an inspection answer set when the company has none that fits", async () => {
    await ensureChecklistDefaults(db, org);
    await db.update(checklistAnswerSets).set({ options: [{ key: "ok", label: "OK", severity: "pass", color: "#059669" }] }).where(eq(checklistAnswerSets.name, "Vehicle inspection"));
    await db.update(checklistAnswerSets).set({ options: [{ key: "ok", label: "OK", severity: "pass", color: "#059669" }] }).where(eq(checklistAnswerSets.name, "Standard"));
    const nl = await addLibraryTemplate(db, org, CHECKLIST_LIBRARY[0].key);
    const [set] = await db.select().from(checklistAnswerSets).where(eq(checklistAnswerSets.id, nl.answerSetId));
    expect(set.name).toBe("Vehicle inspection 2");
    expect(set.options.map((o) => o.severity)).toEqual(["pass", "minor", "major", "na"]);
  });
});
