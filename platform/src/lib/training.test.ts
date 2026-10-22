import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { certificationTypes, machineCategories, machines, notificationDeliveries, notificationEvents, operators, organizations, trainingRecords } from "@/lib/db/schema";
import { DEFAULT_SECTIONS } from "@/lib/checklists";
import { createMachine } from "@/lib/machines";
import { checkIn, createOperator, setMachineOperators } from "@/lib/operators";
import { addUser } from "@/lib/organizations";
import { createRule, processEvents } from "@/lib/notifications";
import { eraseOperator, exportOperator } from "@/lib/privacy";
import {
  addCategory,
  addTrainingRecord,
  createCertificationType,
  DEFAULT_CERTIFICATIONS,
  defaultExpiry,
  deleteCategory,
  ensureTrainingDefaults,
  guessCategory,
  latestRecords,
  recordStatus,
  sendTrainingReminders,
  TrainingError,
  trainingAccess,
  updateCertificationType,
  updateTrainingRecord,
  type CertificationInput,
  type RecordInput,
} from "./training";

let db: Db;
let org: number;
let excavator: number;
let loader: number;
let excavatorCat: number;
let fetchMock: ReturnType<typeof vi.fn>;
const manager = { userId: null, email: "pat@abc.com" };
/** Toronto in October is UTC-4. */
const toronto = (iso: string) => new Date(`${iso}-04:00`);
const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));

const cert = (extra: Partial<CertificationInput> = {}): CertificationInput => ({
  name: "Excavator ticket",
  description: "",
  validityMonths: 36,
  categoryIds: [excavatorCat],
  machineIds: [],
  autoGrant: false,
  required: false,
  graceDays: 0,
  reminderDays: [30, 7],
  active: true,
  ...extra,
});
const record = (certificationTypeId: number, issuedOn: string, expiresOn: string | null): RecordInput => ({
  certificationTypeId,
  issuedOn,
  expiresOn,
  provider: "",
  certificateNumber: "",
  notes: "",
});
const codeOf = async (id: number) => (await db.select({ code: machines.code }).from(machines).where(eq(machines.id, id)))[0].code;

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("ALERT_EMAIL_TO", "");
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  [{ id: org }] = await db.insert(organizations).values({ name: "ABC", timezone: "America/Toronto" }).returning();
  ({ id: excavator } = await createMachine(db, org, { name: "CAT 320", machineType: "Excavator", tier: "monitor" }));
  ({ id: loader } = await createMachine(db, org, { name: "CAT 950", machineType: "Wheel Loader", tier: "monitor" }));
  await ensureTrainingDefaults(db, org);
  [{ id: excavatorCat }] = await db.select().from(machineCategories).where(eq(machineCategories.name, "Excavator"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("defaults", () => {
  it("creates starter categories (filling in existing machines') and switched-off certifications, once", async () => {
    const cats = await db.select().from(machineCategories);
    expect(cats.length).toBe(16);
    const fleet = await db.select().from(machines);
    const name = (id: number | null) => cats.find((c) => c.id === id)?.name;
    expect(fleet.map((m) => name(m.categoryId)).sort()).toEqual(["Excavator", "Wheel loader"]);
    const types = await db.select().from(certificationTypes);
    expect(types).toHaveLength(DEFAULT_CERTIFICATIONS.length);
    expect(types.every((t) => !t.active)).toBe(true);
    expect(types.find((t) => t.name === "Excavator operator")!.categoryIds.length).toBe(2);
    await ensureTrainingDefaults(db, org);
    expect(await db.select().from(machineCategories)).toHaveLength(16);
  });

  it("guesses categories from free-text machine types", () => {
    expect(guessCategory("Mini Excavator")).toBe("Mini excavator");
    expect(guessCategory("CTL")).toBe("Skid steer / compact track loader");
    expect(guessCategory("Scissor lift")).toBe("Aerial work platform");
    expect(guessCategory("Tri-axle dump truck")).toBe("Dump truck (on-road)");
    expect(guessCategory("Generator")).toBeNull();
  });

  it("deleting a category takes it off machines and certifications", async () => {
    const extra = await addCategory(db, org, "Hydrovac");
    await expect(addCategory(db, org, "Hydrovac")).rejects.toBeInstanceOf(TrainingError);
    const t = await createCertificationType(db, org, cert({ name: "Hydrovac", categoryIds: [extra.id, excavatorCat] }));
    await deleteCategory(db, org, excavatorCat);
    const [row] = await db.select().from(certificationTypes).where(eq(certificationTypes.id, t.id));
    expect(row.categoryIds).toEqual([extra.id]);
    expect((await db.select().from(machines).where(eq(machines.id, excavator)))[0].categoryId).toBeNull();
  });
});

describe("certification types", () => {
  it("needs both access questions answered, and machines to cover when either is Yes", async () => {
    await expect(createCertificationType(db, org, cert({ autoGrant: null }))).rejects.toThrow(/both access questions/);
    await expect(createCertificationType(db, org, cert({ required: null }))).rejects.toThrow(/both access questions/);
    await expect(createCertificationType(db, org, cert({ required: true, categoryIds: [] }))).rejects.toThrow(/machines or categories/);
    const ok = await createCertificationType(db, org, cert({ categoryIds: [], name: "Site orientation" }));
    expect(ok.reminderDays).toEqual([30, 7]);
    await expect(createCertificationType(db, org, cert({ name: "Site orientation" }))).rejects.toThrow(/already/);
  });

  it("can't cover another company's machines", async () => {
    const [{ id: other }] = await db.insert(organizations).values({ name: "XYZ" }).returning();
    const { id: theirs } = await createMachine(db, other, { name: "Theirs" });
    await expect(createCertificationType(db, org, cert({ machineIds: [theirs] }))).rejects.toThrow(/machines it covers/);
  });
});

describe("dates and status", () => {
  it("works out the expiry from the validity, keeping month ends valid", () => {
    expect(defaultExpiry("2026-03-15", 36)).toBe("2029-03-15");
    expect(defaultExpiry("2024-02-29", 12)).toBe("2025-02-28");
    expect(defaultExpiry("2026-10-31", 1)).toBe("2026-11-30");
    expect(defaultExpiry("2026-10-31", null)).toBeNull();
  });

  it("is valid, expiring soon, in grace, or expired", () => {
    const type = { graceDays: 14, reminderDays: [30, 7] };
    expect(recordStatus({ expiresOn: null }, type, "2026-10-22")).toMatchObject({ status: "valid", counts: true });
    expect(recordStatus({ expiresOn: "2027-10-22" }, type, "2026-10-22")).toMatchObject({ status: "valid", counts: true });
    expect(recordStatus({ expiresOn: "2026-11-01" }, type, "2026-10-22")).toMatchObject({ status: "expiring", daysLeft: 10, counts: true });
    expect(recordStatus({ expiresOn: "2026-10-22" }, type, "2026-10-22")).toMatchObject({ status: "expiring", daysLeft: 0, counts: true });
    expect(recordStatus({ expiresOn: "2026-10-10" }, type, "2026-10-22")).toMatchObject({ status: "grace", counts: true });
    expect(recordStatus({ expiresOn: "2026-10-01" }, type, "2026-10-22")).toMatchObject({ status: "expired", counts: false });
  });

  it("keeps only the latest record of each certification per operator", () => {
    const rows = [
      { id: 1, operatorId: 1, certificationTypeId: 1, expiresOn: "2026-01-01" },
      { id: 2, operatorId: 1, certificationTypeId: 1, expiresOn: "2029-01-01" },
      { id: 3, operatorId: 1, certificationTypeId: 2, expiresOn: "2029-01-01" },
      { id: 4, operatorId: 1, certificationTypeId: 2, expiresOn: null },
      { id: 5, operatorId: 2, certificationTypeId: 1, expiresOn: "2020-01-01" },
    ];
    expect(latestRecords(rows, (r) => r).map((r) => r.id).sort()).toEqual([2, 4, 5]);
  });
});

describe("access at check-in", () => {
  const now = toronto("2026-10-22T08:00");

  it("Required: no valid record, no check-in; renewing restores it straight away", async () => {
    const t = await createCertificationType(db, org, cert({ required: true, graceDays: 7 }));
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    const tryCheckIn = async (machineId: number) => checkIn(db, { confirmed: true, machineCode: await codeOf(machineId), pin: "1111", answers: allOk }, now);

    expect(await tryCheckIn(excavator)).toEqual({ ok: false, reason: "training-required", questions: ["Excavator ticket"] });
    // Not covered: the loader is fine.
    expect(await tryCheckIn(loader)).toMatchObject({ ok: true });

    const r = await addTrainingRecord(db, org, jane.id, record(t.id, "2023-10-01", "2026-10-18"), manager, null, now);
    expect(await trainingAccess(db, org, { id: excavator, categoryId: excavatorCat }, jane.id, now)).toEqual({ granted: false, missing: [] }); // in grace
    await updateTrainingRecord(db, org, r.id, record(t.id, "2023-10-01", "2026-10-01"));
    expect((await trainingAccess(db, org, { id: excavator, categoryId: excavatorCat }, jane.id, now)).missing).toEqual(["Excavator ticket"]);
    await addTrainingRecord(db, org, jane.id, record(t.id, "2026-10-20", "2029-10-20"), manager, null, now);
    expect(await tryCheckIn(excavator)).toMatchObject({ ok: true });
  });

  it("Auto-grant: a valid record approves the operator on covered machines; switched off, nothing changes", async () => {
    const t = await createCertificationType(db, org, cert({ autoGrant: true }));
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    const bob = await createOperator(db, org, { name: "Bob", pin: "2222" });
    await setMachineOperators(db, org, excavator, [bob.id]);
    const code = await codeOf(excavator);
    expect(await checkIn(db, { confirmed: true, machineCode: code, pin: "1111", answers: allOk }, now)).toMatchObject({ ok: true, authorized: false });

    await addTrainingRecord(db, org, jane.id, record(t.id, "2026-01-01", "2029-01-01"), manager, null, now);
    expect(await checkIn(db, { confirmed: true, machineCode: code, pin: "1111", answers: allOk }, now)).toMatchObject({ ok: true, authorized: true });

    await updateCertificationType(db, org, t.id, cert({ autoGrant: true, active: false }));
    expect(await checkIn(db, { confirmed: true, machineCode: code, pin: "1111", answers: allOk }, now)).toMatchObject({ ok: true, authorized: false });
  });

  it("covers specific machines as well as categories", async () => {
    const t = await createCertificationType(db, org, cert({ name: "Loader 950 familiarization", categoryIds: [], machineIds: [loader], required: true }));
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    expect((await trainingAccess(db, org, { id: loader, categoryId: null }, jane.id, now)).missing).toEqual([t.name]);
    expect((await trainingAccess(db, org, { id: excavator, categoryId: excavatorCat }, jane.id, now)).missing).toEqual([]);
  });
});

describe("records", () => {
  it("checks dates and the operator's company", async () => {
    const t = await createCertificationType(db, org, cert());
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    await expect(addTrainingRecord(db, org, jane.id, record(t.id, "", null), manager)).rejects.toThrow(/issued/);
    await expect(addTrainingRecord(db, org, jane.id, record(t.id, "2026-01-01", "2025-01-01"), manager)).rejects.toThrow(/after the issue date/);
    const [{ id: other }] = await db.insert(organizations).values({ name: "XYZ" }).returning();
    await expect(addTrainingRecord(db, other, jane.id, record(t.id, "2026-01-01", null), manager)).rejects.toThrow(/Operator not found/);
  });
});

describe("reminders", () => {
  it("reminds managers and emails the operator at each step, once, and starts again after a renewal", async () => {
    const t = await createCertificationType(db, org, cert({ required: true, reminderDays: [30, 7] }));
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    await db.update(operators).set({ email: "jane@example.com" }).where(eq(operators.id, jane.id));
    const user = await addUser(db, org, { email: "boss@abc.com", role: "manager" });
    await createRule(db, org, user.id, {
      name: "Training",
      eventTypes: ["training_expiring", "training_expired"],
      machineIds: [],
      divisionIds: [],
      operatorIds: [],
      worksiteIds: [],
      weekdays: [],
      startTime: "",
      endTime: "",
    });
    const r = await addTrainingRecord(db, org, jane.id, record(t.id, "2023-11-20", "2026-11-20"), manager);

    const run = async (day: string) => {
      const ids = await sendTrainingReminders(db, toronto(`${day}T09:00`));
      await processEvents(db, {}, toronto(`${day}T09:00`));
      return ids.length;
    };
    expect(await run("2026-10-01")).toBe(0); // 50 days out
    expect(await run("2026-10-22")).toBe(1); // 29 days: the 30-day reminder
    expect(await run("2026-10-23")).toBe(0);
    expect(await run("2026-11-14")).toBe(1); // 6 days: the 7-day reminder
    expect(await run("2026-11-21")).toBe(1); // expired
    expect(await run("2026-11-22")).toBe(0);

    const events = await db.select().from(notificationEvents).orderBy(notificationEvents.id);
    expect(events.map((e) => [e.type, e.machineId, e.operatorId])).toEqual([
      ["training_expiring", null, jane.id],
      ["training_expiring", null, jane.id],
      ["training_expired", null, jane.id],
    ]);
    expect(events[0].detail).toContain("Jane's Excavator ticket expires on 2026-11-20 (in 29 days)");
    const deliveries = await db.select().from(notificationDeliveries);
    expect(deliveries.filter((d) => d.status === "sent")).toHaveLength(3);
    const recipients = fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).to[0]);
    expect(recipients.filter((to) => to === "jane@example.com")).toHaveLength(3);
    expect(recipients.filter((to) => to === "boss@abc.com")).toHaveLength(3);

    // A renewal (a new record) is the latest: no more reminders for the old one.
    await addTrainingRecord(db, org, jane.id, record(t.id, "2026-11-22", "2029-11-22"), manager);
    expect(await run("2026-12-01")).toBe(0);
    // Editing the expiry date starts its reminders again.
    await updateTrainingRecord(db, org, r.id, record(t.id, "2023-11-20", "2026-12-20"));
    expect((await db.select().from(trainingRecords).where(eq(trainingRecords.id, r.id)))[0].remindedDays).toBeNull();
  });
});

describe("privacy", () => {
  it("exports and erases an operator's training records and contact details", async () => {
    const t = await createCertificationType(db, org, cert());
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    await db.update(operators).set({ email: "jane@example.com", phone: "+14165550123" }).where(eq(operators.id, jane.id));
    await addTrainingRecord(db, org, jane.id, { ...record(t.id, "2026-01-01", null), certificateNumber: "A-1" }, manager);
    const data = await exportOperator(db, org, jane.id);
    expect(JSON.stringify(data)).toContain("A-1");
    expect(JSON.stringify(data)).toContain("jane@example.com");
    await eraseOperator(db, org, jane.id);
    expect(await db.select().from(trainingRecords)).toHaveLength(0);
    const [row] = await db.select().from(operators).where(eq(operators.id, jane.id));
    expect([row.email, row.phone]).toEqual([null, null]);
  });
});
