import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { devices, machines, notificationDeliveries, notificationEvents, organizations } from "@/lib/db/schema";
import { DEFAULT_SECTIONS } from "@/lib/checklists";
import { createDivision, setUserDivisions } from "@/lib/divisions";
import { createMachine, pairDevice } from "@/lib/machines";
import { checkIn, createOperator, syncCheckins } from "@/lib/operators";
import { addUser } from "@/lib/organizations";
import { ingestSamples } from "@/lib/telemetry/ingest";
import {
  createRule,
  inSchedule,
  listRules,
  processEvents,
  recentActivity,
  recordEvent,
  ruleMatches,
  setRuleEnabled,
  updateRule,
  type RuleInput,
} from "./notifications";

let db: Db;
let org: number;
let otherOrg: number;
let east: number;
let west: number;
let eastMachine: number;
let westMachine: number;
let fetchMock: ReturnType<typeof vi.fn>;

const blank: RuleInput = {
  name: "Rule",
  eventTypes: ["start"],
  machineIds: [],
  divisionIds: [],
  operatorIds: [],
  weekdays: [],
  startTime: "",
  endTime: "",
};
/** Toronto in October is UTC-4. */
const toronto = (iso: string) => new Date(`${iso}-04:00`);
const sentTo = () => fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body).to[0]).sort();

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  vi.stubEnv("APP_TIMEZONE", "America/Toronto");
  vi.stubEnv("RESEND_API_KEY", "re_test");
  vi.stubEnv("ALERT_EMAIL_TO", "");
  fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  [{ id: org }, { id: otherOrg }] = await db.insert(organizations).values([{ name: "ABC" }, { name: "XYZ" }]).returning();
  ({ id: east } = await createDivision(db, org, "East"));
  ({ id: west } = await createDivision(db, org, "West"));
  ({ id: eastMachine } = await createMachine(db, org, { name: "Excavator", unitNumber: "14", divisionId: east }));
  ({ id: westMachine } = await createMachine(db, org, { name: "Loader", divisionId: west }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("schedule", () => {
  const rule = (weekdays: number[], startTime = "", endTime = "") => ({ weekdays, startTime, endTime, timezone: "America/Toronto" });

  it("checks days and a daytime window in the rule's time zone", () => {
    const weekdays9to5 = rule([1, 2, 3, 4, 5], "09:00", "17:00");
    expect(inSchedule(weekdays9to5, toronto("2026-10-14T09:00"))).toBe(true); // Wednesday, From is included
    expect(inSchedule(weekdays9to5, toronto("2026-10-14T17:00"))).toBe(false); // To is not
    expect(inSchedule(weekdays9to5, toronto("2026-10-17T10:00"))).toBe(false); // Saturday
    expect(inSchedule(rule([]), toronto("2026-10-17T03:00"))).toBe(true); // empty = any time
    expect(inSchedule(rule([6]), toronto("2026-10-17T23:30"))).toBe(true); // Saturday night, local
  });

  it("runs windows that end before they start overnight, counting the morning as the day it started", () => {
    const fridayNight = rule([5], "18:00", "06:00");
    expect(inSchedule(fridayNight, toronto("2026-10-16T22:00"))).toBe(true); // Fri 22:00
    expect(inSchedule(fridayNight, toronto("2026-10-17T05:59"))).toBe(true); // Sat 05:59, Friday's night
    expect(inSchedule(fridayNight, toronto("2026-10-17T06:00"))).toBe(false);
    expect(inSchedule(fridayNight, toronto("2026-10-16T05:00"))).toBe(false); // Fri morning = Thursday's night
    expect(inSchedule(fridayNight, toronto("2026-10-16T12:00"))).toBe(false);
  });
});

describe("matching", () => {
  const base = { ...blank, enabled: true, timezone: "America/Toronto", eventTypes: ["start", "stop"] };
  const event = (operatorId: number | null = null) => ({ type: "start", operatorId, occurredAt: new Date() });
  const machine = { id: 1, divisionId: 5 };

  it("filters by event type, machine or division, and operator", () => {
    expect(ruleMatches(base, event(), machine)).toBe(true);
    expect(ruleMatches({ ...base, eventTypes: ["stop"] }, event(), machine)).toBe(false);
    expect(ruleMatches({ ...base, enabled: false }, event(), machine)).toBe(false);
    expect(ruleMatches({ ...base, machineIds: [2] }, event(), machine)).toBe(false);
    expect(ruleMatches({ ...base, machineIds: [2], divisionIds: [5] }, event(), machine)).toBe(true);
    expect(ruleMatches({ ...base, operatorIds: [9] }, event(9), machine)).toBe(true);
    expect(ruleMatches({ ...base, operatorIds: [9] }, event(8), machine)).toBe(false);
    expect(ruleMatches({ ...base, operatorIds: [9] }, event(null), machine)).toBe(false); // no operator → no match
  });
});

describe("rules", () => {
  it("validates what's saved", async () => {
    const user = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    await expect(createRule(db, org, user.id, { ...blank, name: " " })).rejects.toThrow(/name/);
    await expect(createRule(db, org, user.id, { ...blank, eventTypes: [] })).rejects.toThrow(/at least one event/);
    await expect(createRule(db, org, user.id, { ...blank, eventTypes: ["nope"] })).rejects.toThrow(/Unknown event/);
    await expect(createRule(db, org, user.id, { ...blank, startTime: "08:00" })).rejects.toThrow(/both From and To/);
    const foreign = await createMachine(db, otherOrg, { name: "Theirs" });
    await expect(createRule(db, org, user.id, { ...blank, machineIds: [foreign.id] })).rejects.toThrow(/Machine not found/);
    const theirOperator = await createOperator(db, otherOrg, { name: "Bob", pin: "1234" });
    await expect(createRule(db, org, user.id, { ...blank, operatorIds: [theirOperator.id] })).rejects.toThrow(/Operator not found/);
    await setUserDivisions(db, org, user.id, [east]);
    await expect(createRule(db, org, user.id, { ...blank, machineIds: [westMachine] })).rejects.toThrow(/Machine not found/);
    const rule = await createRule(db, org, user.id, { ...blank, name: " Nights ", machineIds: [eastMachine], startTime: "18:00", endTime: "06:00" });
    expect(rule).toMatchObject({ name: "Nights", timezone: "America/Toronto", enabled: true });
  });

  it("keeps a paused rule paused when it's edited, and only its owner's organization can change it", async () => {
    const user = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    const rule = await createRule(db, org, user.id, blank);
    await setRuleEnabled(db, org, user.id, rule.id, false);
    await updateRule(db, org, user.id, rule.id, { ...blank, name: "Renamed" });
    const rules = await listRules(db, org, user.id);
    expect(rules.find((r) => r.id === rule.id)).toMatchObject({ name: "Renamed", enabled: false });
    await expect(updateRule(db, otherOrg, user.id, rule.id, blank)).rejects.toThrow(/User not found/);
  });

  it("gives new owners and managers an 'All alerts' rule; viewers none", async () => {
    const manager = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    const viewer = await addUser(db, org, { email: "v@abc.com", role: "viewer" });
    expect((await listRules(db, org, manager.id)).map((r) => [r.name, r.eventTypes.length])).toEqual([["All alerts", 4]]);
    expect(await listRules(db, org, viewer.id)).toEqual([]);
  });
});

describe("delivery", () => {
  const at = (min: number) => new Date(toronto("2026-10-14T10:00").getTime() + min * 60_000);

  it("emails engine starts and stops with the operator from the check-in", async () => {
    const user = await addUser(db, org, { email: "starts@abc.com", role: "viewer" });
    await createRule(db, org, user.id, { ...blank, name: "Starts", eventTypes: ["start", "stop"] });
    const jane = await createOperator(db, org, { name: "Jane", pin: "1111" });
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", eastMachine, at(-60));
    const [{ code }] = await db.select({ code: machines.code }).from(machines).where(eq(machines.id, eastMachine));
    await checkIn(db, { confirmed: true, machineCode: code, pin: "1111", answers: Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"])) }, at(-2));

    await ingestSamples(db, "DEV1", [{ batteryCentivolts: 1400 }], { now: at(0) });
    await syncCheckins(db, eastMachine, at(0));
    await processEvents(db, { machineId: eastMachine }, at(0));
    await ingestSamples(db, "DEV1", [{ batteryCentivolts: 1250 }], { now: at(30) });
    await processEvents(db, { machineId: eastMachine }, at(30));

    const events = await db.select().from(notificationEvents).orderBy(notificationEvents.id);
    expect(events.map((e) => [e.type, e.operatorId, e.processedAt !== null])).toEqual([
      ["start", jane.id, true],
      ["stop", jane.id, true],
    ]);
    expect(sentTo()).toEqual(["starts@abc.com", "starts@abc.com"]);
    const first = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(first.subject).toBe("Machine Start: Unit 14 · Excavator");
    expect(first.text).toContain("Operator: Jane");
    expect(first.text).toContain("Your subscription: Starts");
    // Processing again sends nothing new.
    await processEvents(db, { machineId: eastMachine }, at(31));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sends one email per person, only in schedule, only for machines they can see", async () => {
    const owner = await addUser(db, org, { email: "owner@abc.com", role: "owner" }); // + default All alerts rule
    await createRule(db, org, owner.id, { ...blank, name: "Unit 14 changes", eventTypes: ["equipment_updated"], machineIds: [eastMachine] });
    await createRule(db, org, owner.id, { ...blank, name: "All changes", eventTypes: ["equipment_updated"] });
    const westOnly = await addUser(db, org, { email: "west@abc.com", role: "manager" });
    await setUserDivisions(db, org, westOnly.id, [west]);
    await createRule(db, org, westOnly.id, { ...blank, name: "Everything", eventTypes: ["equipment_updated"] });
    const nights = await addUser(db, org, { email: "nights@abc.com", role: "viewer" });
    await createRule(db, org, nights.id, { ...blank, name: "Nights", eventTypes: ["equipment_updated"], startTime: "18:00", endTime: "06:00" });
    const paused = await addUser(db, org, { email: "paused@abc.com", role: "viewer" });
    const p = await createRule(db, org, paused.id, { ...blank, name: "Paused", eventTypes: ["equipment_updated"] });
    await setRuleEnabled(db, org, paused.id, p.id, false);
    await addUser(db, otherOrg, { email: "x@xyz.com", role: "owner" });

    const id = await recordEvent(db, { organizationId: org, machineId: eastMachine, type: "equipment_updated", occurredAt: at(0) });
    await processEvents(db, { eventIds: [id!] }, at(0));
    expect(sentTo()).toEqual(["owner@abc.com"]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).text).toContain("Your subscriptions: Unit 14 changes, All changes");
    const [delivery] = await db.select().from(notificationDeliveries);
    expect(delivery).toMatchObject({ userId: owner.id, status: "sent", recipient: "owner@abc.com" });

    // The activity panel shows it, with what was sent.
    const [activity] = await recentActivity(db, owner, 24 * 365 * 10);
    expect(activity).toMatchObject({ label: "Equipment Updated", machine: "Unit 14 · Excavator", delivery: { status: "sent" } });
    expect(await recentActivity(db, westOnly, 24 * 365 * 10)).toEqual([]);
  });

  it("only sends alerts to ALERT_EMAIL_TO, not other events, and records email not set up", async () => {
    vi.stubEnv("ALERT_EMAIL_TO", "staff@veristart.ca");
    const id = await recordEvent(db, { organizationId: org, machineId: eastMachine, type: "equipment_created" });
    await processEvents(db, { eventIds: [id!] });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("RESEND_API_KEY", "");
    const user = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    await createRule(db, org, user.id, { ...blank, eventTypes: ["equipment_created"] });
    const second = await recordEvent(db, { organizationId: org, machineId: eastMachine, type: "equipment_created" });
    await processEvents(db, { eventIds: [second!] });
    const rows = await db.select().from(notificationDeliveries).where(eq(notificationDeliveries.userId, user.id));
    expect(rows.map((r) => r.status)).toEqual(["not-configured"]);
  });
});
