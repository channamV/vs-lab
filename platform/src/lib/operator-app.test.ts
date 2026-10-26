import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, machines, organizations } from "@/lib/db/schema";
import { coveringChecklist, DEFAULT_SECTIONS, ensureChecklistDefaults } from "@/lib/checklists";
import { deviceKey, unlockSignature } from "@/lib/commands";
import { createMachine, pairDevice } from "@/lib/machines";
import { checkIn, createOperator, setMachineOperators, updateOperator } from "@/lib/operators";
import { beaconCheckIn } from "@/lib/relay";
import {
  APP_RULES,
  appAuth,
  appChecklist,
  appMachines,
  offlinePasses,
  passForCheckin,
  replaceAppStart,
  requestLoginCode,
  signOutApp,
  unlockPass,
  verifyLoginCode,
} from "./operator-app";

const T0 = Date.parse("2026-10-26T15:00:00Z");
const at = (min: number) => new Date(T0 + min * 60_000);

describe("operator app", () => {
  let db: Db;
  let org: number;
  let loader: number;
  let truck: number;
  let jane: number;
  let bob: number;
  const allOk = Object.fromEntries(DEFAULT_SECTIONS.flatMap((s) => s.questions).map((q) => [q.id, "ok"]));

  beforeEach(async () => {
    process.env.DEVICE_KEY_SECRET = "test-secret";
    db = createDb();
    await migrateDb(db, false);
    [{ id: org }] = await db.insert(organizations).values({ name: "ABC Paving", timezone: "America/St_Johns" }).returning();
    ({ id: loader } = await createMachine(db, org, { name: "Loader", tier: "control" }));
    ({ id: truck } = await createMachine(db, org, { name: "Truck", tier: "monitor" }));
    await db.update(machines).set({ code: "LDR1", mode: "access_controlled" }).where(eq(machines.id, loader));
    await db.update(machines).set({ code: "TRK1" }).where(eq(machines.id, truck));
    await db.insert(devices).values({ id: "DEV1" });
    await pairDevice(db, "DEV1", loader, at(-60));
    jane = (await createOperator(db, org, { name: "Jane", pin: "1111", email: "Jane@Example.com" })).id;
    bob = (await createOperator(db, org, { name: "Bob", pin: "2222" })).id;
    await ensureChecklistDefaults(db, org);
  });
  afterEach(() => {
    delete process.env.DEVICE_KEY_SECRET;
  });

  async function signIn() {
    const code = await requestLoginCode(db, " jane@example.com ", at(0));
    const [account] = (await verifyLoginCode(db, "JANE@example.com", code!, "Pixel 8", at(1)))!;
    return (await appAuth(db, `Bearer ${account.token}`, at(2)))!;
  }

  it("signs in with an emailed code: once, limited tries, nothing for unknown addresses", async () => {
    expect(await requestLoginCode(db, "nobody@example.com", at(0))).toBeNull();
    const code = await requestLoginCode(db, "jane@example.com", at(0));
    expect(code).toMatch(/^\d{6}$/);
    expect(await verifyLoginCode(db, "jane@example.com", "000000" === code ? "111111" : "000000", null, at(1))).toBeNull();
    const accounts = await verifyLoginCode(db, "jane@example.com", code!, "Pixel 8", at(1));
    expect(accounts).toMatchObject([{ operatorId: jane, operatorName: "Jane", organizationName: "ABC Paving" }]);
    expect(await verifyLoginCode(db, "jane@example.com", code!, null, at(2))).toBeNull(); // used
    const auth = await appAuth(db, `Bearer ${accounts![0].token}`, at(3));
    expect(auth).toMatchObject({ operatorId: jane, organizationId: org });
    expect(await appAuth(db, "Bearer nope", at(3))).toBeNull();
    await signOutApp(db, auth!);
    expect(await appAuth(db, `Bearer ${accounts![0].token}`, at(4))).toBeNull();
    // A deactivated operator is signed out.
    const again = await verifyLoginCode(db, "jane@example.com", (await requestLoginCode(db, "jane@example.com", at(5)))!, null, at(5));
    await updateOperator(db, org, jane, { name: "Jane", active: false });
    expect(await appAuth(db, `Bearer ${again![0].token}`, at(6))).toBeNull();
  });

  it("stops after too many codes or wrong tries", async () => {
    for (let i = 0; i < APP_RULES.maxCodesPerHour; i++) expect(await requestLoginCode(db, "jane@example.com", at(i))).not.toBeNull();
    expect(await requestLoginCode(db, "jane@example.com", at(10))).toBeNull();
    const code = await requestLoginCode(db, "jane@example.com", at(70));
    const wrong = code === "123456" ? "654321" : "123456";
    for (let i = 0; i < APP_RULES.maxAttempts; i++) await verifyLoginCode(db, "jane@example.com", wrong, null, at(71));
    expect(await verifyLoginCode(db, "jane@example.com", code!, null, at(72))).toBeNull();
  });

  it("lists the operator's machines with what the app needs", async () => {
    const auth = await signIn();
    await setMachineOperators(db, org, truck, [bob]); // Jane isn't approved on the truck
    const list = await appMachines(db, auth, at(3));
    expect(list.map((m) => m.code)).toEqual(["LDR1"]);
    expect(list[0]).toMatchObject({ mode: "access_controlled", lockedOut: false, relay: { deviceId: "DEV1", bluetoothName: "VS-DEV1" }, checklist: { doneTodayAt: null } });
    const checklist = await appChecklist(db, auth, "LDR1", at(3));
    expect(checklist?.checklist.meter).toEqual({ kind: "hours", value: null, hint: null });
    expect(await appChecklist(db, auth, "NOPE", at(3))).toBeNull();
  });

  it("checks in without a PIN and hands over a signed pass the device can check", async () => {
    const auth = await signIn();
    const result = await checkIn(db, { machineCode: "LDR1", pin: "", operatorId: auth.operatorId, method: "app", answers: allOk, confirmed: true, meterReading: "1200" }, at(5));
    expect(result).toMatchObject({ ok: true, relay: "wait" });
    if (!result.ok) throw new Error();
    expect((await db.select().from(checkins))[0]).toMatchObject({ method: "app", meterReading: 1200 });
    const unlock = await passForCheckin(db, result.checkinId, at(5));
    expect(unlock?.bluetoothName).toBe("VS-DEV1");
    const [tag, op, checkinId, from, until, sig] = unlock!.pass.split("|");
    expect([tag, Number(op), Number(checkinId), Number(until) - Number(from)]).toEqual(["U1", jane, result.checkinId, APP_RULES.unlockMinutes * 60]);
    expect(sig).toBe(unlockSignature(deviceKey("DEV1")!, "DEV1", jane, result.checkinId, Number(from), Number(until)));
    // Bob can't check in through Jane's app sign-in for another company's machine, and an operator id from elsewhere fails.
    const [{ id: other }] = await db.insert(organizations).values({ name: "Other" }).returning();
    const stranger = (await createOperator(db, other, { name: "Zed", pin: "3333" })).id;
    expect(await checkIn(db, { machineCode: "LDR1", pin: "", operatorId: stranger, method: "app", answers: allOk, confirmed: true }, at(6))).toMatchObject({ ok: false, reason: "bad-pin" });
  });

  it("gives offline passes only for relay machines the operator may start now", async () => {
    const auth = await signIn();
    let passes = await offlinePasses(db, auth, at(3));
    expect(passes.map((p) => p.machineCode)).toEqual(["LDR1"]);
    expect(passes[0].pass).toMatch(/^U1\|\d+\|0\|\d+\|\d+\|[0-9a-f]{16}$/);
    await db.update(machines).set({ mode: "locked" }).where(eq(machines.id, loader));
    passes = await offlinePasses(db, auth, at(4));
    expect(passes).toEqual([]);
    expect(unlockPass("DEV1", jane, 0, at(0), at(60)).split("|")[3]).toBe(String(T0 / 1000));
  });

  it("replaces the device's report of an offline app start with the checklist uploaded later", async () => {
    const auth = await signIn();
    // At the machine without signal: checklist done in the app at 0, the pass started the machine at 1.
    await beaconCheckIn(db, "DEV1", { operatorId: jane, beacon: "APP", at: at(1) }, at(2));
    expect((await db.select().from(checkins))[0]).toMatchObject({ method: "app", answers: [] });
    // The empty start doesn't count as today's checklist.
    expect(await coveringChecklist(db, { machineId: loader, operatorId: jane, frequency: "machine_daily", timeZone: "America/St_Johns", now: at(3) })).toBeNull();
    // Back in coverage: the checklist arrives, dated when it was done.
    await replaceAppStart(db, auth, loader, at(0));
    const result = await checkIn(db, { machineCode: "LDR1", pin: "", operatorId: jane, method: "app", startedAt: at(0), answers: allOk, confirmed: true }, at(30));
    expect(result).toMatchObject({ ok: true });
    const rows = await db.select().from(checkins);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "app", startedAt: at(0) });
    expect(rows[0].answers.length).toBeGreaterThan(0);
  });
});
