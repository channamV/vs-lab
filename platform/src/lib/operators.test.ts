import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, engineSessions, operators } from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";
import {
  CHECKIN_RULES,
  checkIn,
  checkinEngine,
  checkLocation,
  distanceMeters,
  checkOut,
  createOperator,
  isCheckinCurrent,
  OperatorError,
  setMachineOperators,
  syncCheckins,
  updateOperator,
} from "./operators";

let db: Db;
const allOk = Object.fromEntries(CHECKLIST.map((item) => [item.id, true]));

beforeEach(async () => {
  db = createDb(); // in-memory database
  await migrateDb(db, false);
  await db.insert(devices).values([{ id: "DEV00001" }, { id: "DEV00002" }]);
});

describe("operators", () => {
  it("stores a hashed PIN, never the PIN itself", async () => {
    const op = await createOperator(db, { name: "  Jane Smith ", pin: "4821" });
    expect(op.name).toBe("Jane Smith");
    expect(op.pinHash).not.toContain("4821");
  });

  it("rejects bad and duplicate PINs", async () => {
    await expect(createOperator(db, { name: "A", pin: "12" })).rejects.toBeInstanceOf(OperatorError);
    await expect(createOperator(db, { name: "A", pin: "12ab" })).rejects.toBeInstanceOf(OperatorError);
    const a = await createOperator(db, { name: "A", pin: "1111" });
    await expect(createOperator(db, { name: "B", pin: "1111" })).rejects.toThrow(/already used/);
    // Keeping your own PIN on edit is fine
    await updateOperator(db, a.id, { name: "A", active: true, newPin: "1111" });
  });
});

describe("checkIn", () => {
  it("checks an operator in with a passed checklist", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    const result = await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk, notes: " all good " });
    expect(result).toEqual({
      ok: true,
      checkinId: expect.any(Number),
      operatorName: "Jane",
      authorized: true,
      checklistOk: true,
      failedItems: [],
      location: "no-phone-location",
      distanceM: null,
      engineRunning: false,
    });
    const [row] = await db.select().from(checkins);
    expect(row).toMatchObject({ deviceId: "DEV00001", endedAt: null, notes: "all good", checklistOk: true });
    expect(row.answers).toHaveLength(CHECKLIST.length);
  });

  it("records and flags failed checklist items without blocking", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    const result = await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: { ...allOk, seatbelt: false } });
    expect(result).toMatchObject({ ok: true, checklistOk: false, failedItems: ["Seatbelt in good condition and working"] });
  });

  it("requires every checklist item to be answered", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    const missingOne = { ...allOk, seatbelt: undefined };
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: missingOne })).toEqual({ ok: false, reason: "incomplete" });
    expect(await db.select().from(checkins)).toHaveLength(0);
  });

  it("rejects unknown machines, wrong PINs and inactive operators", async () => {
    const op = await createOperator(db, { name: "Jane", pin: "1111" });
    expect(await checkIn(db, { deviceId: "NOPE", pin: "1111", answers: allOk })).toEqual({ ok: false, reason: "unknown-machine" });
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "9999", answers: allOk })).toEqual({ ok: false, reason: "bad-pin" });
    await updateOperator(db, op.id, { name: "Jane", active: false });
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk })).toEqual({ ok: false, reason: "bad-pin" });
  });

  it("locks the machine's check-in page after too many wrong PINs", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    const now = new Date("2026-10-15T12:00:00Z");
    for (let i = 0; i < CHECKIN_RULES.maxPinFailures; i++) {
      await checkIn(db, { deviceId: "DEV00001", pin: "0000", answers: allOk }, now);
    }
    // Even the right PIN is refused during the lockout, but other machines are unaffected
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, now)).toEqual({ ok: false, reason: "locked" });
    expect((await checkIn(db, { deviceId: "DEV00002", pin: "1111", answers: allOk }, now)).ok).toBe(true);
    // After the lockout period it works again
    const later = new Date(now.getTime() + (CHECKIN_RULES.lockoutMinutes + 1) * 60_000);
    expect((await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, later)).ok).toBe(true);
  });

  it("flags operators who aren't on the machine's allowed list", async () => {
    const jane = await createOperator(db, { name: "Jane", pin: "1111" });
    await createOperator(db, { name: "Bob", pin: "2222" });
    await setMachineOperators(db, "DEV00001", [jane.id]);
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "2222", answers: allOk })).toMatchObject({ ok: true, authorized: false });
    expect(await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk })).toMatchObject({ ok: true, authorized: true });
    // No list on the other machine → anyone active is allowed
    expect(await checkIn(db, { deviceId: "DEV00002", pin: "2222", answers: allOk })).toMatchObject({ ok: true, authorized: true });
  });

  it("replaces the previous operator and moves an operator between machines", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    await createOperator(db, { name: "Bob", pin: "2222" });
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk });
    await checkIn(db, { deviceId: "DEV00001", pin: "2222", answers: allOk }); // Bob takes over DEV00001
    await checkIn(db, { deviceId: "DEV00002", pin: "2222", answers: allOk }); // Bob moves to DEV00002

    const rows = await db.select().from(checkins).orderBy(checkins.id);
    expect(rows.map((r) => [r.deviceId, r.endReason])).toEqual([
      ["DEV00001", "replaced"],
      ["DEV00001", "moved"],
      ["DEV00002", null],
    ]);
  });
});

describe("checkOut", () => {
  it("only the checked-in operator can check out", async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    await createOperator(db, { name: "Bob", pin: "2222" });
    expect(await checkOut(db, { deviceId: "DEV00001", pin: "1111" })).toEqual({ ok: false, reason: "not-checked-in" });
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk });
    expect(await checkOut(db, { deviceId: "DEV00001", pin: "2222" })).toEqual({ ok: false, reason: "bad-pin" });
    expect(await checkOut(db, { deviceId: "DEV00001", pin: "1111" })).toEqual({ ok: true, operatorName: "Jane" });
    const [row] = await db.select().from(checkins);
    expect(row.endReason).toBe("checkout");
  });

  it("deactivating an operator checks them out", async () => {
    const jane = await createOperator(db, { name: "Jane", pin: "1111" });
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk });
    await updateOperator(db, jane.id, { name: "Jane", active: false });
    const [row] = await db.select().from(checkins);
    expect(row.endReason).toBe("deactivated");
    expect((await db.select().from(operators))[0].active).toBe(false);
  });
});

describe("location check", () => {
  const machine = { lat: 43.6527, lng: -79.3835 };
  // ~0.0009° latitude ≈ 100 m
  const offsetNorth = (m: number) => ({ lat: machine.lat + m / 111_195, lng: machine.lng });

  it("measures distance in metres", () => {
    expect(distanceMeters(machine, offsetNorth(100))).toBeCloseTo(100, 0);
    // Toronto → Mississauga, about 23 km
    expect(distanceMeters(machine, { lat: 43.589, lng: -79.644 }) / 1000).toBeCloseTo(22.1, 0);
  });

  it("is near within 100 m plus the phone's accuracy (capped)", () => {
    expect(checkLocation({ ...offsetNorth(90), accuracyM: 10 }, machine).check).toBe("near");
    expect(checkLocation({ ...offsetNorth(150), accuracyM: 10 }, machine).check).toBe("far");
    expect(checkLocation({ ...offsetNorth(150), accuracyM: 60 }, machine).check).toBe("near");
    // A very inaccurate phone fix can't stretch the limit past 100 + 150 m
    expect(checkLocation({ ...offsetNorth(400), accuracyM: 2000 }, machine).check).toBe("far");
  });

  it("says why it couldn't check", () => {
    expect(checkLocation(null, machine)).toEqual({ check: "no-phone-location", distanceM: null });
    expect(checkLocation({ ...machine, accuracyM: 5 }, { lat: null, lng: null })).toEqual({
      check: "no-machine-location",
      distanceM: null,
    });
  });

  it("is stored with the check-in", async () => {
    await db.update(devices).set({ lastLat: machine.lat, lastLng: machine.lng });
    await createOperator(db, { name: "Jane", pin: "1111" });
    const near = await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk, phoneLocation: { ...offsetNorth(20), accuracyM: 8 } });
    expect(near).toMatchObject({ ok: true, location: "near" });
    const far = await checkIn(db, { deviceId: "DEV00002", pin: "1111", answers: allOk, phoneLocation: { lat: 43.7, lng: -79.4, accuracyM: 8 } });
    expect(far).toMatchObject({ ok: true, location: "far" });
    const none = await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk });
    expect(none).toMatchObject({ ok: true, location: "no-phone-location" });

    const rows = await db.select().from(checkins).orderBy(checkins.id);
    expect(rows.map((r) => r.locationCheck)).toEqual(["near", "far", "no-phone-location"]);
    expect(rows[0].distanceM).toBeCloseTo(20, 0);
    expect(rows[0].phoneAccuracyM).toBe(8);
  });
});

describe("check-in follows the engine", () => {
  const t0 = new Date("2026-10-15T11:00:00Z"); // check-in time
  const at = (min: number) => new Date(t0.getTime() + min * 60_000);
  const window = CHECKIN_RULES.engineStartWindowMinutes;
  const startEngine = async (deviceId: string, min: number) =>
    (await db.insert(engineSessions).values({ deviceId, startedAt: at(min), lastSeenAt: at(min) }).returning())[0];
  const engineReport = (id: number, min: number) => db.update(engineSessions).set({ lastSeenAt: at(min) }).where(eq(engineSessions.id, id));
  const stopEngine = (id: number, min: number) =>
    db.update(engineSessions).set({ endedAt: at(min), lastSeenAt: at(min) }).where(eq(engineSessions.id, id));
  const rows = () => db.select().from(checkins).orderBy(checkins.id);

  beforeEach(async () => {
    await createOperator(db, { name: "Jane", pin: "1111" });
    await createOperator(db, { name: "Bob", pin: "2222" });
  });

  it("links the engine start within the window, then checks out when the engine stops", async () => {
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, at(0));
    const s = await startEngine("DEV00001", 3);
    await syncCheckins(db, "DEV00001", at(3));
    expect((await rows())[0]).toMatchObject({ engineSessionId: s.id, engineLink: "started", endedAt: null });

    // Still checked in while the engine runs, long after the window
    await engineReport(s.id, 60);
    await syncCheckins(db, "DEV00001", at(60));
    expect((await rows())[0].endedAt).toBeNull();

    await stopEngine(s.id, 95);
    await syncCheckins(db, "DEV00001", at(96));
    expect((await rows())[0]).toMatchObject({ endedAt: at(95), endReason: "engine stopped" });
  });

  it("checks the operator out if the engine doesn't start within the window", async () => {
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, at(0));
    await syncCheckins(db, "DEV00001", at(window - 1));
    expect((await rows())[0].endedAt).toBeNull();
    await syncCheckins(db, "DEV00001", at(window + 2));
    expect((await rows())[0]).toMatchObject({ endedAt: at(window), endReason: "no start" });
    // A start after that isn't linked to the old check-in
    await startEngine("DEV00001", window + 3);
    await syncCheckins(db, "DEV00001", at(window + 3));
    expect((await rows())[0].engineSessionId).toBeNull();
  });

  it("ends a check-in when the device goes silent while running", async () => {
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, at(0));
    await startEngine("DEV00001", 1);
    await syncCheckins(db, "DEV00001", at(1));
    await syncCheckins(db, "DEV00001", at(30)); // no reports since minute 1 → session gone stale
    expect((await rows())[0]).toMatchObject({ endedAt: at(1), endReason: "engine stopped" });
  });

  it("links straight away when the engine is already running", async () => {
    const s = await startEngine("DEV00001", -10);
    const result = await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, at(0));
    expect(result).toMatchObject({ ok: true, engineRunning: true });
    expect((await rows())[0]).toMatchObject({ engineSessionId: s.id, engineLink: "already-running" });
  });

  it("treats a check-in on another operator's running engine as a takeover", async () => {
    await checkIn(db, { deviceId: "DEV00001", pin: "1111", answers: allOk }, at(0));
    const s = await startEngine("DEV00001", 2);
    await syncCheckins(db, "DEV00001", at(2));
    await engineReport(s.id, 240);
    await checkIn(db, { deviceId: "DEV00001", pin: "2222", answers: allOk }, at(240)); // shift change, engine idling
    const [jane, bob] = await rows();
    expect(jane).toMatchObject({ endReason: "replaced", endedAt: at(240) });
    expect(bob).toMatchObject({ engineSessionId: s.id, engineLink: "takeover", endedAt: null });
  });

  it("describes the engine for each check-in", () => {
    const base = { startedAt: at(0), endedAt: null, engineSessionId: null, engineLink: null, endReason: null };
    const session = { startedAt: at(4), endedAt: null, lastSeenAt: at(10) };
    expect(checkinEngine({ ...base, engineSessionId: 1, engineLink: "started" }, session, at(10).getTime())).toEqual({ kind: "started", minutes: 4 });
    expect(checkinEngine(base, null, at(2).getTime())).toEqual({ kind: "waiting" });
    expect(checkinEngine(base, null, at(window + 1).getTime())).toEqual({ kind: "no-start" });
    expect(checkinEngine({ ...base, engineLink: "takeover", engineSessionId: 1 }, session)).toEqual({ kind: "takeover" });
    expect(checkinEngine({ ...base, endedAt: at(2), endReason: "checkout" }, null)).toEqual({ kind: "not-used" });
  });
});
