import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { alerts, checkins, machines, operators, organizations, users } from "@/lib/db/schema";
import { authFromToken, redeemSignInLink, requestSignInLink } from "@/lib/auth";
import { createMachine } from "@/lib/machines";
import { alertRecipients } from "@/lib/notify";
import {
  assertAlertInScope,
  assertCheckinInScope,
  assertDivisionChoice,
  assertMachineInScope,
  canSeeMachine,
  createDivision,
  deleteDivision,
  machineScope,
  renameDivision,
  setUserDivisions,
  type Scope,
} from "./divisions";

let db: Db;
let org: number;
let otherOrg: number;
let east: number;
let west: number;
let eastMachine: number;
let westMachine: number;
let noDivisionMachine: number;

beforeEach(async () => {
  db = createDb();
  await migrateDb(db, false);
  [{ id: org }, { id: otherOrg }] = await db.insert(organizations).values([{ name: "ABC Civil" }, { name: "XYZ" }]).returning();
  ({ id: east } = await createDivision(db, org, "East"));
  ({ id: west } = await createDivision(db, org, " West "));
  ({ id: eastMachine } = await createMachine(db, org, { name: "Excavator", divisionId: east }));
  ({ id: westMachine } = await createMachine(db, org, { name: "Loader", divisionId: west }));
  ({ id: noDivisionMachine } = await createMachine(db, org, { name: "Dozer" }));
});

const visible = async (scope: Scope) =>
  (await db.select({ id: machines.id }).from(machines).where(machineScope(scope))).map((m) => m.id).sort();

describe("what a user sees", () => {
  it("whole organization, or only their divisions' machines", async () => {
    expect(await visible({ organizationId: org, divisionIds: null })).toEqual([eastMachine, westMachine, noDivisionMachine].sort());
    expect(await visible({ organizationId: org, divisionIds: [east] })).toEqual([eastMachine]);
    expect(await visible({ organizationId: org, divisionIds: [east, west] })).toEqual([eastMachine, westMachine].sort());
    expect(await visible({ organizationId: otherOrg, divisionIds: null })).toEqual([]);
    expect(canSeeMachine({ organizationId: org, divisionIds: [east] }, { organizationId: org, divisionId: null })).toBe(false);
  });

  it("blocks actions on machines, check-ins and alerts outside the user's divisions", async () => {
    const eastOnly = { organizationId: org, divisionIds: [east] };
    await assertMachineInScope(db, eastOnly, eastMachine);
    await expect(assertMachineInScope(db, eastOnly, westMachine)).rejects.toThrow(/not found/);
    const [op] = await db.insert(operators).values({ organizationId: org, name: "Jane", pinHash: "x" }).returning();
    const [westCheckin] = await db
      .insert(checkins)
      .values({ organizationId: org, machineId: westMachine, operatorId: op.id, authorized: true, checklistOk: true, answers: [] })
      .returning();
    const [westAlert] = await db
      .insert(alerts)
      .values({ organizationId: org, machineId: westMachine, type: "not-approved", title: "t" })
      .returning();
    await expect(assertCheckinInScope(db, eastOnly, westCheckin.id)).rejects.toThrow(/not found/);
    await expect(assertAlertInScope(db, eastOnly, westAlert.id)).rejects.toThrow(/not found/);
    await assertAlertInScope(db, { organizationId: org, divisionIds: null }, westAlert.id);
    await expect(assertAlertInScope(db, { organizationId: otherOrg, divisionIds: null }, westAlert.id)).rejects.toThrow(/not found/);
  });

  it("limited users must keep machines in their own divisions", async () => {
    const eastOnly = { organizationId: org, divisionIds: [east] };
    await assertDivisionChoice(db, eastOnly, east);
    await expect(assertDivisionChoice(db, eastOnly, west)).rejects.toThrow(/your divisions/);
    await expect(assertDivisionChoice(db, eastOnly, null)).rejects.toThrow(/your divisions/);
    await assertDivisionChoice(db, { organizationId: org, divisionIds: null }, null);
    await expect(assertDivisionChoice(db, { organizationId: otherOrg, divisionIds: null }, east)).rejects.toThrow(/not found/);
    await expect(createMachine(db, otherOrg, { name: "Sneaky", divisionId: east })).rejects.toThrow(/Division not found/);
  });

  it("comes from sign-in: limits apply to managers and viewers, never owners", async () => {
    await db.insert(users).values([
      { organizationId: org, email: "owner@abc.com", role: "owner" },
      { organizationId: org, email: "east@abc.com", role: "manager" },
      { organizationId: org, email: "all@abc.com", role: "viewer" },
    ]);
    const [eastUser, owner] = await Promise.all(
      ["east@abc.com", "owner@abc.com"].map(async (email) => (await db.select().from(users)).find((u) => u.email === email)!),
    );
    await setUserDivisions(db, org, eastUser.id, [east]);
    await setUserDivisions(db, org, owner.id, [west]); // ignored for owners
    const signIn = async (email: string) => {
      const token = await requestSignInLink(db, email);
      const session = await redeemSignInLink(db, token!);
      return authFromToken(db, session!.token);
    };
    expect((await signIn("east@abc.com"))!.divisionIds).toEqual([east]);
    expect((await signIn("owner@abc.com"))!.divisionIds).toBeNull();
    expect((await signIn("all@abc.com"))!.divisionIds).toBeNull();
  });
});

describe("managing divisions", () => {
  it("keeps names unique and only deletes empty divisions", async () => {
    await expect(createDivision(db, org, "East")).rejects.toThrow(/already a division/);
    await createDivision(db, otherOrg, "East"); // another organization: fine
    await renameDivision(db, org, west, "Western");
    await expect(renameDivision(db, otherOrg, west, "Hijack")).rejects.toThrow(/not found/);

    await expect(deleteDivision(db, org, east)).rejects.toThrow(/still has machines/);
    await db.delete(machines).where(machineScope({ organizationId: org, divisionIds: [east] }));
    const [user] = await db.insert(users).values({ organizationId: org, email: "e@abc.com", role: "manager" }).returning();
    await setUserDivisions(db, org, user.id, [east]);
    // Deleting it would silently give this user the whole organization, so it's refused.
    await expect(deleteDivision(db, org, east)).rejects.toThrow(/limited to East/);
    await setUserDivisions(db, org, user.id, []);
    await deleteDivision(db, org, east);
  });

  it("won't limit a user to another organization's division", async () => {
    const [user] = await db.insert(users).values({ organizationId: otherOrg, email: "x@xyz.com", role: "manager" }).returning();
    await expect(setUserDivisions(db, otherOrg, user.id, [east])).rejects.toThrow(/not found/);
    await expect(setUserDivisions(db, org, user.id, [east])).rejects.toThrow(/User not found/);
  });
});

describe("alert emails", () => {
  it("go to owners and managers who can see the machine", async () => {
    const people = await db
      .insert(users)
      .values([
        { organizationId: org, email: "owner@abc.com", role: "owner" },
        { organizationId: org, email: "east-mgr@abc.com", role: "manager" },
        { organizationId: org, email: "west-mgr@abc.com", role: "manager" },
        { organizationId: org, email: "all-mgr@abc.com", role: "manager" },
        { organizationId: org, email: "east-viewer@abc.com", role: "viewer" },
      ])
      .returning();
    const id = (email: string) => people.find((p) => p.email === email)!.id;
    await setUserDivisions(db, org, id("east-mgr@abc.com"), [east]);
    await setUserDivisions(db, org, id("west-mgr@abc.com"), [west]);
    await setUserDivisions(db, org, id("east-viewer@abc.com"), [east]);

    expect((await alertRecipients(db, eastMachine)).sort()).toEqual(["all-mgr@abc.com", "east-mgr@abc.com", "owner@abc.com"]);
    expect((await alertRecipients(db, noDivisionMachine)).sort()).toEqual(["all-mgr@abc.com", "owner@abc.com"]);
  });
});
