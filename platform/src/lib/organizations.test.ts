import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, machineOperators, organizations, users } from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";
import { checkIn, createOperator, OperatorError, setMachineOperators, updateOperator } from "@/lib/operators";
import { AccountError, addUser, assignDevice, updateUser } from "./organizations";

let db: Db;
let orgA: number;
let orgB: number;
const allOk = Object.fromEntries(CHECKLIST.map((item) => [item.id, true]));

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: orgA }] = await db.insert(organizations).values({ name: "ABC Civil" }).returning();
  [{ id: orgB }] = await db.insert(organizations).values({ name: "XYZ Paving" }).returning();
  await db.insert(devices).values([
    { id: "A-EXC", organizationId: orgA },
    { id: "B-EXC", organizationId: orgB },
    { id: "NEW01" }, // unclaimed
  ]);
});

describe("operators in different organizations", () => {
  it("can share names and PINs: the machine says which organization", async () => {
    const johnA = await createOperator(db, orgA, { name: "John Smith", pin: "1234" });
    const johnB = await createOperator(db, orgB, { name: "John Smith", pin: "1234" });
    expect(johnA.id).not.toBe(johnB.id);

    const onA = await checkIn(db, { deviceId: "A-EXC", pin: "1234", answers: allOk });
    const onB = await checkIn(db, { deviceId: "B-EXC", pin: "1234", answers: allOk });
    expect(onA.ok && onB.ok).toBe(true);
    const rows = await db.select().from(checkins).orderBy(checkins.id);
    expect(rows.map((r) => [r.deviceId, r.operatorId, r.organizationId])).toEqual([
      ["A-EXC", johnA.id, orgA],
      ["B-EXC", johnB.id, orgB],
    ]);
  });

  it("allows two operators with the same name in one organization, told apart by employee number", async () => {
    await createOperator(db, orgA, { name: "John Smith", pin: "1111", employeeNumber: "1042" });
    await createOperator(db, orgA, { name: "John Smith", pin: "2222", employeeNumber: "2219" });
    await expect(createOperator(db, orgA, { name: "Someone", pin: "3333", employeeNumber: "1042" })).rejects.toBeInstanceOf(OperatorError);
    // Employee numbers can repeat across organizations
    await createOperator(db, orgB, { name: "Pat", pin: "1111", employeeNumber: "1042" });
  });

  it("keeps PINs unique within an organization", async () => {
    await createOperator(db, orgA, { name: "Jane", pin: "1234" });
    await expect(createOperator(db, orgA, { name: "Joe", pin: "1234" })).rejects.toThrow(/already used/);
  });

  it("won't let one organization check in, edit or approve another's operators", async () => {
    const bOnly = await createOperator(db, orgB, { name: "Bob", pin: "5555" });
    expect(await checkIn(db, { deviceId: "A-EXC", pin: "5555", answers: allOk })).toEqual({ ok: false, reason: "bad-pin" });
    await expect(updateOperator(db, orgA, bOnly.id, { name: "Hacked", active: true })).rejects.toThrow(/not found/);
    await setMachineOperators(db, orgA, "A-EXC", [bOnly.id]);
    expect(await db.select().from(machineOperators)).toHaveLength(0);
    await expect(setMachineOperators(db, orgA, "B-EXC", [])).rejects.toThrow(/not found/);
  });

  it("doesn't accept check-ins on unclaimed machines", async () => {
    await createOperator(db, orgA, { name: "Jane", pin: "1234" });
    expect(await checkIn(db, { deviceId: "NEW01", pin: "1234", answers: allOk })).toEqual({ ok: false, reason: "unknown-machine" });
  });
});

describe("users", () => {
  it("allows one organization per email", async () => {
    await addUser(db, orgA, { email: "Jane@ABC.com", role: "owner" });
    await expect(addUser(db, orgB, { email: "jane@abc.com", role: "viewer" })).rejects.toThrow(/another organization/);
    await expect(addUser(db, orgA, { email: "not-an-email", role: "viewer" })).rejects.toBeInstanceOf(AccountError);
  });

  it("always keeps an active owner", async () => {
    const owner = await addUser(db, orgA, { email: "owner@abc.com", role: "owner" });
    await expect(updateUser(db, orgA, owner.id, { role: "manager", active: true })).rejects.toThrow(/at least one active owner/);
    await addUser(db, orgA, { email: "owner2@abc.com", role: "owner" });
    await updateUser(db, orgA, owner.id, { role: "manager", active: true });
    expect((await db.select().from(users).where(eq(users.id, owner.id)))[0].role).toBe("manager");
    // Another organization can't touch this user
    await expect(updateUser(db, orgB, owner.id, { role: "viewer", active: false })).rejects.toThrow(/not found/);
  });
});

describe("assigning machines", () => {
  it("claims an unclaimed machine, and moving one clears what belonged to the old organization", async () => {
    await assignDevice(db, "NEW01", orgA);
    expect((await db.select().from(devices).where(eq(devices.id, "NEW01")))[0].organizationId).toBe(orgA);

    const jane = await createOperator(db, orgA, { name: "Jane", pin: "1234" });
    await setMachineOperators(db, orgA, "A-EXC", [jane.id]);
    await checkIn(db, { deviceId: "A-EXC", pin: "1234", answers: allOk });
    await assignDevice(db, "A-EXC", orgB);

    expect(await db.select().from(machineOperators)).toHaveLength(0);
    const [old] = await db.select().from(checkins);
    expect(old).toMatchObject({ endReason: "machine moved", organizationId: orgA }); // history stays with ABC
    await assignDevice(db, "A-EXC", null);
    expect((await db.select().from(devices).where(eq(devices.id, "A-EXC")))[0].organizationId).toBeNull();
  });
});
