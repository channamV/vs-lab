import { createHash } from "node:crypto";
import { and, eq, gte, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, devices, machineOperators, operators, pinFailures, type ChecklistAnswer } from "@/lib/db/schema";
import { CHECKLIST } from "@/lib/checklist";

/**
 * Operators, machine assignments and QR check-in (Tier 2 — Safety & Access Monitoring).
 * Plain functions that take the database, so they can be tested without a server.
 */

export const PIN_PATTERN = /^\d{4,8}$/;

export const CHECKIN_RULES = {
  /** A check-in left open longer than this no longer counts as "checked in" (a forgotten check-out). */
  maxHours: 12,
  /** Wrong PINs allowed per machine within `lockoutMinutes` before the page stops accepting PINs. */
  maxPinFailures: 5,
  lockoutMinutes: 10,
};

/**
 * PINs are looked up by hash, so the same PIN always gives the same hash (no per-row salt).
 * A 4–8 digit PIN can't be protected by hashing alone; the rate limit is what stops guessing.
 */
export function hashPin(pin: string): string {
  return createHash("sha256").update(`vs-lab-pin-v1:${pin}`).digest("hex");
}

export class OperatorError extends Error {}

function checkPin(pin: string) {
  if (!PIN_PATTERN.test(pin)) throw new OperatorError("PIN must be 4 to 8 digits.");
}

async function assertPinFree(db: Db, pin: string, exceptOperatorId?: number) {
  const [taken] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.pinHash, hashPin(pin)), exceptOperatorId ? ne(operators.id, exceptOperatorId) : undefined));
  if (taken) throw new OperatorError("That PIN is already used by another operator. Choose a different one.");
}

export async function createOperator(db: Db, input: { name: string; pin: string }) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  checkPin(input.pin);
  await assertPinFree(db, input.pin);
  const [row] = await db.insert(operators).values({ name, pinHash: hashPin(input.pin) }).returning();
  return row;
}

export async function updateOperator(db: Db, id: number, input: { name: string; active: boolean; newPin?: string }) {
  const name = input.name.trim();
  if (!name) throw new OperatorError("Enter the operator's name.");
  const changes: Partial<typeof operators.$inferInsert> = { name, active: input.active };
  if (input.newPin) {
    checkPin(input.newPin);
    await assertPinFree(db, input.newPin, id);
    changes.pinHash = hashPin(input.newPin);
  }
  await db.update(operators).set(changes).where(eq(operators.id, id));
  // A deactivated operator is checked out everywhere.
  if (!input.active) {
    await db
      .update(checkins)
      .set({ endedAt: new Date(), endReason: "deactivated" })
      .where(and(eq(checkins.operatorId, id), isNull(checkins.endedAt)));
  }
}

/** Replaces the list of operators allowed on a machine. An empty list means any active operator. */
export async function setMachineOperators(db: Db, deviceId: string, operatorIds: number[]) {
  await db.transaction(async (tx) => {
    await tx.delete(machineOperators).where(eq(machineOperators.deviceId, deviceId));
    if (operatorIds.length) {
      await tx.insert(machineOperators).values([...new Set(operatorIds)].map((operatorId) => ({ deviceId, operatorId })));
    }
  });
}

/** Whether an open check-in still counts at `now` (not older than CHECKIN_RULES.maxHours). */
export function isCheckinCurrent(c: { startedAt: Date; endedAt: Date | null }, now = Date.now()): boolean {
  return !c.endedAt && now - c.startedAt.getTime() < CHECKIN_RULES.maxHours * 3_600_000;
}

async function isLockedOut(db: Db, deviceId: string, now: Date) {
  const since = new Date(now.getTime() - CHECKIN_RULES.lockoutMinutes * 60_000);
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pinFailures)
    .where(and(eq(pinFailures.deviceId, deviceId), gte(pinFailures.at, since)));
  return count >= CHECKIN_RULES.maxPinFailures;
}

/** Finds the active operator with this PIN. Wrong PINs are recorded for the rate limit. */
async function operatorForPin(db: Db, deviceId: string, pin: string, now: Date) {
  const [operator] = PIN_PATTERN.test(pin)
    ? await db
        .select()
        .from(operators)
        .where(and(eq(operators.pinHash, hashPin(pin)), eq(operators.active, true)))
    : [];
  if (!operator) await db.insert(pinFailures).values({ deviceId, at: now });
  return operator ?? null;
}

export type CheckinFailure = "unknown-machine" | "locked" | "bad-pin" | "incomplete" | "not-checked-in";

export type CheckInResult =
  | { ok: true; operatorName: string; authorized: boolean; checklistOk: boolean; failedItems: string[] }
  | { ok: false; reason: CheckinFailure };

/**
 * An operator checks in to a machine: PIN plus the pre-start checklist.
 * `answers` maps each checklist item id to true (OK) or false (not OK); every item must be answered.
 * Ends any open check-in on this machine (replaced) and the operator's open check-in elsewhere (moved).
 */
export async function checkIn(
  db: Db,
  input: { deviceId: string; pin: string; answers: Record<string, boolean | undefined>; notes?: string },
  now = new Date(),
): Promise<CheckInResult> {
  const [device] = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, input.deviceId));
  if (!device) return { ok: false, reason: "unknown-machine" };
  if (await isLockedOut(db, device.id, now)) return { ok: false, reason: "locked" };

  const operator = await operatorForPin(db, device.id, input.pin, now);
  if (!operator) return { ok: false, reason: "bad-pin" };

  if (CHECKLIST.some((item) => typeof input.answers[item.id] !== "boolean")) return { ok: false, reason: "incomplete" };
  const answers: ChecklistAnswer[] = CHECKLIST.map((item) => ({ id: item.id, question: item.question, ok: input.answers[item.id]! }));
  const failedItems = answers.filter((a) => !a.ok).map((a) => a.question);

  const allowed = await db
    .select({ operatorId: machineOperators.operatorId })
    .from(machineOperators)
    .where(eq(machineOperators.deviceId, device.id));
  const authorized = allowed.length === 0 || allowed.some((a) => a.operatorId === operator.id);

  await db.transaction(async (tx) => {
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "replaced" })
      .where(and(eq(checkins.deviceId, device.id), isNull(checkins.endedAt)));
    await tx
      .update(checkins)
      .set({ endedAt: now, endReason: "moved" })
      .where(and(eq(checkins.operatorId, operator.id), isNull(checkins.endedAt)));
    await tx.insert(checkins).values({
      deviceId: device.id,
      operatorId: operator.id,
      startedAt: now,
      authorized,
      checklistOk: failedItems.length === 0,
      answers,
      notes: input.notes?.trim() || null,
    });
  });

  return { ok: true, operatorName: operator.name, authorized, checklistOk: failedItems.length === 0, failedItems };
}

/** Ends the open check-in on a machine. The PIN must belong to the operator who is checked in. */
export async function checkOut(
  db: Db,
  input: { deviceId: string; pin: string },
  now = new Date(),
): Promise<{ ok: true; operatorName: string } | { ok: false; reason: CheckinFailure }> {
  if (await isLockedOut(db, input.deviceId, now)) return { ok: false, reason: "locked" };
  const [open] = await db
    .select({ id: checkins.id, operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.deviceId, input.deviceId), isNull(checkins.endedAt)));
  if (!open) return { ok: false, reason: "not-checked-in" };

  const operator = await operatorForPin(db, input.deviceId, input.pin, now);
  if (!operator || operator.id !== open.operatorId) {
    if (operator) await db.insert(pinFailures).values({ deviceId: input.deviceId, at: now });
    return { ok: false, reason: "bad-pin" };
  }
  await db.update(checkins).set({ endedAt: now, endReason: "checkout" }).where(eq(checkins.id, open.id));
  return { ok: true, operatorName: operator.name };
}

/** A fleet manager ends a check-in from the machine page (e.g. the operator forgot to check out). */
export async function endCheckin(db: Db, checkinId: number, now = new Date()) {
  await db
    .update(checkins)
    .set({ endedAt: now, endReason: "ended by manager" })
    .where(and(eq(checkins.id, checkinId), isNull(checkins.endedAt)));
}
