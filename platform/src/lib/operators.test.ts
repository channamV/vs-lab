import { beforeEach, describe, expect, it } from "vitest";
import { createDb, migrateDb, type Db } from "@/lib/db";
import { checkins, devices, operators } from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";
import {
  CHECKIN_RULES,
  checkIn,
  checkinTiming,
  checkLocation,
  distanceMeters,
  checkOut,
  createOperator,
  isCheckinCurrent,
  OperatorError,
  setMachineOperators,
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

describe("isCheckinCurrent", () => {
  it("treats check-ins older than the shift limit as over", () => {
    const now = Date.parse("2026-10-15T20:00:00Z");
    const hoursAgo = (h: number) => new Date(now - h * 3_600_000);
    expect(isCheckinCurrent({ startedAt: hoursAgo(2), endedAt: null }, now)).toBe(true);
    expect(isCheckinCurrent({ startedAt: hoursAgo(CHECKIN_RULES.maxHours + 1), endedAt: null }, now)).toBe(false);
    expect(isCheckinCurrent({ startedAt: hoursAgo(2), endedAt: hoursAgo(1) }, now)).toBe(false);
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

describe("timing rule", () => {
  const t0 = Date.parse("2026-10-15T11:00:00Z"); // check-in time
  const min = (m: number) => new Date(t0 + m * 60_000);
  const session = (from: number, to: number | null) => ({ startedAt: min(from), endedAt: to === null ? null : min(to), lastSeenAt: min(to ?? from) });
  const open = { startedAt: min(0), endedAt: null };
  const window = CHECKIN_RULES.engineStartWindowMinutes;

  it("is on time when the engine starts within the window", () => {
    expect(checkinTiming(open, [session(12, 80)], min(90).getTime())).toEqual({ kind: "on-time", minutes: 12 });
  });

  it("waits during the window, then flags a late or missing start", () => {
    expect(checkinTiming(open, [], min(10).getTime())).toEqual({ kind: "waiting" });
    expect(checkinTiming(open, [], min(window + 5).getTime())).toEqual({ kind: "late", minutes: null });
    // Checked in at 6 am, engine started 3 hours later
    expect(checkinTiming(open, [session(180, 240)], min(250).getTime())).toEqual({ kind: "late", minutes: 180 });
  });

  it("notes an engine that was already running at check-in", () => {
    expect(checkinTiming(open, [session(-20, 60)], min(70).getTime())).toEqual({ kind: "already-running" });
    // A session that ended before check-in doesn't count
    expect(checkinTiming(open, [session(-60, -30), session(5, 60)], min(70).getTime())).toEqual({ kind: "on-time", minutes: 5 });
  });

  it("ignores engine starts after check-out", () => {
    const ended = { startedAt: min(0), endedAt: min(10) };
    expect(checkinTiming(ended, [session(20, 60)], min(70).getTime())).toEqual({ kind: "not-used" });
    const endedLate = { startedAt: min(0), endedAt: min(window + 30) };
    expect(checkinTiming(endedLate, [session(window + 40, window + 90)], min(200).getTime())).toEqual({ kind: "late", minutes: null });
  });
});
