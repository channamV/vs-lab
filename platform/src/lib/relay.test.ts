import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, deviceCommands, devices, machines, operators, organizations } from "@/lib/db/schema";
import { queryChecklistResults, parseResultFilters } from "@/lib/checklist-results";
import { DEFAULT_SECTIONS, ensureChecklistDefaults } from "@/lib/checklists";
import { createMachine, pairDevice } from "@/lib/machines";
import { syncRelayMode } from "@/lib/modes";
import { checkIn, cleanBeaconName, createOperator, setMachineOperators, updateOperator } from "@/lib/operators";
import { accessCommand, beaconCheckIn, confirmRelayAnswer, RelayError, sendAllow, sendRevoke, shouldAllow, syncAccessList } from "./relay";

const T0 = Date.parse("2026-10-26T15:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);

describe("relay rules (pure)", () => {
  it("builds the beacon list command with a version that only depends on the list", () => {
    const a = accessCommand([
      { beacon: "VS-BEACON-22", operatorId: 7 },
      { beacon: "VS-BEACON-20", operatorId: 5 },
    ]);
    expect(a.command).toBe(`ACCESS=${a.version}\tVS-BEACON-20:5,VS-BEACON-22:7`);
    expect(accessCommand([{ beacon: "VS-BEACON-20", operatorId: 5 }, { beacon: "VS-BEACON-22", operatorId: 7 }]).version).toBe(a.version);
    expect(accessCommand([]).command).toMatch(/^ACCESS=[0-9a-f]{8}\t$/);
  });
  it("cleans beacon names", () => {
    expect(cleanBeaconName(" vs-beacon-20 ")).toBe("VS-BEACON-20");
    expect(cleanBeaconName("")).toBeNull();
    expect(cleanBeaconName("bad name!")).toEqual({ error: expect.any(String) });
  });
  it("lets an approved check-in start only on an Access-Controlled relay machine", () => {
    const m: Parameters<typeof shouldAllow>[0] = { tier: "control", mode: "access_controlled", modeUntil: null, modeRevertTo: null, lockedOutAt: null };
    const c = { authorized: true, lockoutRequested: false, endedAt: null };
    expect(shouldAllow(m, c, T0)).toBe(true);
    expect(shouldAllow({ ...m, tier: "monitor" }, c, T0)).toBe(false);
    expect(shouldAllow({ ...m, mode: "unlocked" }, c, T0)).toBe(false); // Unlocked: the relay is already closed
    expect(shouldAllow({ ...m, lockedOutAt: new Date(T0) }, c, T0)).toBe(false);
    expect(shouldAllow(m, { ...c, authorized: false }, T0)).toBe(false);
  });
});

describe("relay commands", () => {
  let db: Db;
  let org: number;
  let machineId: number;
  let jane: number;
  let bob: number;
  const commands = async () =>
    (await db.select().from(deviceCommands).orderBy(deviceCommands.id)).map((c) => [c.command.split("\t")[0], c.status]);

  beforeEach(async () => {
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC" }).returning();
    ({ id: machineId } = await createMachine(db, org, { name: "Loader", tier: "control" }));
    await db.update(machines).set({ code: "LDR1", mode: "access_controlled" }).where(eq(machines.id, machineId));
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", machineId, at(-60));
    jane = (await createOperator(db, org, { name: "Jane", pin: "1111" })).id;
    bob = (await createOperator(db, org, { name: "Bob", pin: "2222" })).id;
  });

  const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));
  const qrCheckIn = async (pin: string, min: number) => {
    await ensureChecklistDefaults(db, org);
    return checkIn(db, { machineCode: "LDR1", pin, answers: allOk, confirmed: true }, at(min));
  };

  it("sends ALLOW after an approved QR check-in, replaces it with the next one, and REVOKE ends it", async () => {
    await setMachineOperators(db, org, machineId, [jane]);
    const first = await qrCheckIn("1111", 0);
    expect(first).toMatchObject({ ok: true, relay: "wait" });
    if (!first.ok) throw new Error();
    expect(await sendAllow(db, first.checkinId, at(0))).toBe(true);
    // Bob isn't approved: recorded, but the starter stays blocked.
    const second = await qrCheckIn("2222", 1);
    expect(second).toMatchObject({ ok: true, relay: "blocked", authorized: false });
    if (!second.ok) throw new Error();
    expect(await sendAllow(db, second.checkinId, at(1))).toBe(false);
    expect(await commands()).toEqual([["ALLOW=" + first.checkinId, "pending"]]);
    await sendRevoke(db, first.checkinId, at(2));
    expect(await commands()).toEqual([
      ["ALLOW=" + first.checkinId, "cancelled"],
      ["REVOKE=" + first.checkinId, "pending"],
    ]);
    // The device acting on an ALLOW is recorded on the check-in.
    await confirmRelayAnswer(db, "DEV1", `ALLOW=${first.checkinId}\t5\t30`, true, at(3));
    expect((await db.select().from(checkins).where(eq(checkins.id, first.checkinId)))[0].relayAllowedAt).toEqual(at(3));
  });

  it("sends Locked while the machine is locked out for repair, and the mode again when it's cleared", async () => {
    await db.update(machines).set({ lockedOutAt: at(0) }).where(eq(machines.id, machineId));
    await syncRelayMode(db, machineId, "test", at(0));
    await db.update(machines).set({ lockedOutAt: null }).where(eq(machines.id, machineId));
    await syncRelayMode(db, machineId, "test", at(1));
    const rows = await db.select().from(deviceCommands).orderBy(deviceCommands.id);
    expect(rows.map((r) => [r.command.split("\t")[0], r.status])).toEqual([
      ["MODE=locked", "cancelled"],
      ["MODE=access_controlled", "pending"],
    ]);
  });

  it("keeps the device's beacon list up to date with approvals and beacons", async () => {
    await updateOperator(db, org, jane, { name: "Jane", active: true, beaconName: "vs-beacon-20" });
    await updateOperator(db, org, bob, { name: "Bob", active: true, beaconName: "VS-BEACON-22" });
    await expect(updateOperator(db, org, bob, { name: "Bob", active: true, beaconName: "VS-BEACON-20" })).rejects.toThrow("already given");
    expect(await syncAccessList(db, machineId, at(0))).toBe(true);
    expect(await syncAccessList(db, machineId, at(1))).toBe(false); // unchanged
    let [cmd] = await db.select().from(deviceCommands);
    expect(cmd.command).toContain(`VS-BEACON-20:${jane},VS-BEACON-22:${bob}`);
    // Only Jane approved now: a new list replaces the unanswered one.
    await setMachineOperators(db, org, machineId, [jane]);
    expect(await syncAccessList(db, machineId, at(2))).toBe(true);
    const all = await db.select().from(deviceCommands).orderBy(deviceCommands.id);
    expect(all.map((c) => c.status)).toEqual(["cancelled", "pending"]);
    cmd = all[1];
    expect(cmd.command.split("\t")[1]).toBe(`VS-BEACON-20:${jane}`);
    await confirmRelayAnswer(db, "DEV1", cmd.command, true, at(3));
    expect((await db.select().from(machines))[0].accessListHash).toBe(cmd.command.slice(7, 15));
    // Not a relay machine: nothing sent.
    await db.update(machines).set({ tier: "monitor" }).where(eq(machines.id, machineId));
    await setMachineOperators(db, org, machineId, []);
    expect(await syncAccessList(db, machineId, at(4))).toBe(false);
  });

  it("turns a beacon start into a check-in without a checklist, once", async () => {
    await updateOperator(db, org, jane, { name: "Jane", active: true, beaconName: "VS-BEACON-20" });
    const id = await beaconCheckIn(db, "DEV1", { operatorId: jane, beacon: "vs-beacon-20", at: at(-1) }, at(0));
    expect(await beaconCheckIn(db, "DEV1", { operatorId: jane, beacon: "VS-BEACON-20", at: at(0) }, at(0))).toBe(id);
    const [c] = await db.select().from(checkins);
    expect(c).toMatchObject({ method: "ble", operatorId: jane, startedAt: at(-1), answers: [], locationCheck: "near" });
    await expect(beaconCheckIn(db, "DEV1", { operatorId: bob, beacon: "VS-BEACON-20", at: at(0) }, at(0))).rejects.toThrow(RelayError);
    // Not a checklist result.
    const { total } = await queryChecklistResults(db, org, { organizationId: org, divisionIds: null }, parseResultFilters({ covered: "1" }, T0, "America/Toronto"));
    expect(total).toBe(0);
    expect((await db.select().from(operators)).length).toBe(2);
  });
});
