import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, machineOperators, machines, organizations, users } from "@/lib/db/schema";
import { DEFAULT_SECTIONS } from "@/lib/checklists";
import { checkIn, createOperator, OperatorError, setMachineOperators, updateOperator } from "@/lib/operators";
import { AccountError, addUser, updateUser } from "./organizations";

let db: Db;
let orgA: number;
let orgB: number;
let machineA: number;
let machineB: number;
const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: orgA }] = await db.insert(organizations).values({ name: "ABC Civil" }).returning();
  [{ id: orgB }] = await db.insert(organizations).values({ name: "XYZ Paving" }).returning();
  [{ id: machineA }, { id: machineB }] = await db
    .insert(machines)
    .values([
      { organizationId: orgA, code: "A-EXC", name: "Excavator" },
      { organizationId: orgB, code: "B-EXC", name: "Excavator" },
    ])
    .returning();
});

describe("operators in different organizations", () => {
  it("can share names and PINs: the machine says which organization", async () => {
    const johnA = await createOperator(db, orgA, { name: "John Smith", pin: "1234" });
    const johnB = await createOperator(db, orgB, { name: "John Smith", pin: "1234" });
    expect(johnA.id).not.toBe(johnB.id);

    const onA = await checkIn(db, { confirmed: true, machineCode: "A-EXC", pin: "1234", answers: allOk });
    const onB = await checkIn(db, { confirmed: true, machineCode: "B-EXC", pin: "1234", answers: allOk });
    expect(onA.ok && onB.ok).toBe(true);
    const rows = await db.select().from(checkins).orderBy(checkins.id);
    expect(rows.map((r) => [r.machineId, r.operatorId, r.organizationId])).toEqual([
      [machineA, johnA.id, orgA],
      [machineB, johnB.id, orgB],
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
    expect(await checkIn(db, { confirmed: true, machineCode: "A-EXC", pin: "5555", answers: allOk })).toEqual({ ok: false, reason: "bad-pin" });
    await expect(updateOperator(db, orgA, bOnly.id, { name: "Hacked", active: true })).rejects.toThrow(/not found/);
    await setMachineOperators(db, orgA, machineA, [bOnly.id]);
    expect(await db.select().from(machineOperators)).toHaveLength(0);
    await expect(setMachineOperators(db, orgA, machineB, [])).rejects.toThrow(/not found/);
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
