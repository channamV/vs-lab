import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alertSubscriptions, organizations, users } from "@/lib/db/schema";
import { createDivision, setUserDivisions } from "@/lib/divisions";
import { createMachine } from "@/lib/machines";
import { addUser } from "@/lib/organizations";
import { addSubscription, listSubscriptions, removeSubscription, subscribersFor } from "./subscriptions";

let db: Db;
let org: number;
let otherOrg: number;
let east: number;
let west: number;
let eastMachine: number;
let westMachine: number;
let otherMachine: number;
const all = { type: null, divisionId: null, machineId: null, channel: "email" } as const;

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }, { id: otherOrg }] = await db.insert(organizations).values([{ name: "ABC Civil" }, { name: "XYZ" }]).returning();
  ({ id: east } = await createDivision(db, org, "East"));
  ({ id: west } = await createDivision(db, org, "West"));
  ({ id: eastMachine } = await createMachine(db, org, { name: "Excavator", unitNumber: "14", divisionId: east }));
  ({ id: westMachine } = await createMachine(db, org, { name: "Loader", divisionId: west }));
  ({ id: otherMachine } = await createMachine(db, otherOrg, { name: "Dozer" }));
});

const send = (type: string, machineId: number) => subscribersFor(db, { type, machineId }).then((r) => r.sort());

describe("defaults", () => {
  it("owners and managers get every alert by email; viewers start with none", async () => {
    const manager = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    const viewer = await addUser(db, org, { email: "v@abc.com", role: "viewer" });
    expect((await listSubscriptions(db, org, manager.id)).map((s) => [s.what, s.where, s.how])).toEqual([["All alerts", "All machines", "Email"]]);
    expect(await listSubscriptions(db, org, viewer.id)).toEqual([]);
    expect(await send("unauthorized-use", eastMachine)).toEqual(["m@abc.com"]);
  });
});

describe("who gets an alert", () => {
  it("matches alert type, division and machine", async () => {
    const mechanic = await addUser(db, org, { email: "mech@abc.com", role: "viewer" });
    const super_ = await addUser(db, org, { email: "east-super@abc.com", role: "viewer" });
    const watcher = await addUser(db, org, { email: "unit14@abc.com", role: "viewer" });
    await addSubscription(db, org, mechanic.id, { ...all, type: "checklist-failed" });
    await addSubscription(db, org, super_.id, { ...all, divisionId: east });
    await addSubscription(db, org, watcher.id, { ...all, machineId: eastMachine });

    expect(await send("checklist-failed", eastMachine)).toEqual(["east-super@abc.com", "mech@abc.com", "unit14@abc.com"]);
    expect(await send("checklist-failed", westMachine)).toEqual(["mech@abc.com"]);
    expect(await send("unauthorized-use", westMachine)).toEqual([]);
    expect(await send("unauthorized-use", eastMachine)).toEqual(["east-super@abc.com", "unit14@abc.com"]);
  });

  it("never sends alerts for machines the user can't see, to inactive users, or across organizations", async () => {
    const limited = await addUser(db, org, { email: "east-mgr@abc.com", role: "manager" }); // default: all alerts
    await setUserDivisions(db, org, limited.id, [east]);
    const gone = await addUser(db, org, { email: "gone@abc.com", role: "manager" });
    await db.update(users).set({ active: false }).where(eq(users.id, gone.id));
    await addUser(db, otherOrg, { email: "x@xyz.com", role: "owner" });

    expect(await send("unauthorized-use", eastMachine)).toEqual(["east-mgr@abc.com"]);
    expect(await send("unauthorized-use", westMachine)).toEqual([]);
    expect(await send("unauthorized-use", otherMachine)).toEqual(["x@xyz.com"]);
  });

  it("emails each person once even with overlapping subscriptions", async () => {
    const owner = await addUser(db, org, { email: "o@abc.com", role: "owner" });
    await addSubscription(db, org, owner.id, { ...all, type: "not-approved", machineId: eastMachine });
    expect(await send("not-approved", eastMachine)).toEqual(["o@abc.com"]);
  });
});

describe("changing subscriptions", () => {
  it("rejects duplicates, unknown types, and machines or divisions the user can't see", async () => {
    const user = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    await expect(addSubscription(db, org, user.id, all)).rejects.toThrow(/already exists/);
    await expect(addSubscription(db, org, user.id, { ...all, type: "nonsense" as never })).rejects.toThrow(/Unknown alert type/);
    await expect(addSubscription(db, org, user.id, { ...all, machineId: otherMachine })).rejects.toThrow(/Machine not found/);
    await expect(addSubscription(db, org, user.id, { ...all, divisionId: east, machineId: eastMachine })).rejects.toThrow(/not both/);
    await setUserDivisions(db, org, user.id, [east]);
    await expect(addSubscription(db, org, user.id, { ...all, divisionId: west })).rejects.toThrow(/can't see/);
    await expect(addSubscription(db, org, user.id, { ...all, machineId: westMachine })).rejects.toThrow(/can't see/);
    await addSubscription(db, org, user.id, { ...all, machineId: eastMachine });
  });

  it("only within the user's organization", async () => {
    const user = await addUser(db, org, { email: "m@abc.com", role: "manager" });
    const [sub] = await db.select().from(alertSubscriptions).where(eq(alertSubscriptions.userId, user.id));
    await expect(removeSubscription(db, otherOrg, user.id, sub.id)).rejects.toThrow(/User not found/);
    await expect(addSubscription(db, otherOrg, user.id, { ...all, type: "not-approved" })).rejects.toThrow(/User not found/);
    await removeSubscription(db, org, user.id, sub.id);
    expect(await listSubscriptions(db, org, user.id)).toEqual([]);
  });
});
