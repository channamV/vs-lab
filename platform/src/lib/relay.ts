import { createHash } from "node:crypto";
import { and, desc, eq, inArray, isNotNull, isNull, like } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, deviceAssignments, deviceCommands, machineOperators, machines, operators, type Machine } from "@/lib/db/schema";
import { effectiveMode } from "@/lib/modes";
import { CHECKIN_RULES, syncCheckins } from "@/lib/operators";
import { scheduledAccess } from "@/lib/schedules";
import { trainingAccess } from "@/lib/training";

/**
 * Safety & Access Control: the starter relay (docs/starter-relay.md; Craig 2026-10-26, modelled on Veristart's
 * production firmware 4.2.11, which closes a relay on the Freematics external socket, GPIO26, for authorized
 * operators). The device decides on the spot; VS-lab tells it what it needs to know, as device commands:
 *  - MODE=<mode>…: Access-Controlled / Unlocked / Locked (src/lib/modes.ts; a repair lockout counts as Locked).
 *  - ALLOW=<check-in id>\t<start minutes>\t<break minutes>: an approved operator checked in with the QR code: close
 *    the relay until they start (or the start window passes), keep it closed while running and for the break
 *    allowance after it stops.
 *  - REVOKE=<check-in id>: that check-in ended (a manager ended it, the operator was deactivated): open the relay.
 *  - ACCESS=<version>\t<beacon>:<operator id>,…: the operators whose Bluetooth beacon may start this machine without
 *    signal. The device reports a beacon start at /hub/api/access/<device> (a beacon check-in, method "ble").
 * Only machines on the Safety & Access Control tier (`control`) with a paired device get these commands.
 */

export const RELAY_RULES = {
  /** An ALLOW the device hasn't picked up in this long is pointless (the operator has gone). */
  allowExpiryMinutes: 15,
  accessExpiryDays: 7,
  /** Most beacons in one ACCESS command (the device's reply buffer). */
  maxAccessEntries: 60,
  /** A beacon start reported this late (device was offline) still becomes a check-in, dated when it happened. */
  maxReportDelayHours: 24,
};

/** The paired device of a Safety & Access Control machine, or null. */
async function relayDevice(db: Db, machineId: number) {
  const [row] = await db
    .select({ machine: machines, deviceId: deviceAssignments.deviceId })
    .from(machines)
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(eq(machines.id, machineId));
  return row && row.machine.tier === "control" ? row : null;
}

/** Queues a command, cancelling unanswered ones of the same kind (a newer one replaces them). */
async function replaceCommand(db: Db, deviceId: string, prefix: string, command: string, label: string, expiresMs: number, now: Date) {
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.deviceId, deviceId), inArray(deviceCommands.status, ["pending", "sent"]), like(deviceCommands.command, `${prefix}%`)));
  await db.insert(deviceCommands).values({ deviceId, command, label, createdBy: "VS-lab", createdAt: now, expiresAt: new Date(now.getTime() + expiresMs) });
}

/** Whether a check-in should let the operator start a relay machine (pure). */
export function shouldAllow(m: Pick<Machine, "tier" | "mode" | "modeUntil" | "modeRevertTo" | "lockedOutAt">, c: { authorized: boolean; lockoutRequested: boolean; endedAt: Date | null }, now: number) {
  return m.tier === "control" && effectiveMode(m, now).mode === "access_controlled" && c.authorized && !c.lockoutRequested && c.endedAt === null;
}

/** After a QR check-in: let the operator start (when they're approved and the machine is Access-Controlled). */
export async function sendAllow(db: Db, checkinId: number, now = new Date()) {
  const [c] = await db.select().from(checkins).where(eq(checkins.id, checkinId));
  if (!c || (c.method !== "web" && c.method !== "app")) return false;
  const relay = await relayDevice(db, c.machineId);
  if (!relay || !shouldAllow(relay.machine, c, now.getTime())) return false;
  await replaceCommand(
    db,
    relay.deviceId,
    "ALLOW=",
    `ALLOW=${c.id}\t${CHECKIN_RULES.engineStartWindowMinutes}\t${CHECKIN_RULES.breakMinutes[c.method] ?? 0}`,
    `Let check-in #${c.id} start the machine`,
    RELAY_RULES.allowExpiryMinutes * 60_000,
    now,
  );
  return true;
}

/** A check-in was ended by a manager (or the operator deactivated): the device opens the relay if it's that one. */
export async function sendRevoke(db: Db, checkinId: number, now = new Date()) {
  const [c] = await db.select({ id: checkins.id, machineId: checkins.machineId, relayAllowedAt: checkins.relayAllowedAt }).from(checkins).where(eq(checkins.id, checkinId));
  if (!c) return false;
  const relay = await relayDevice(db, c.machineId);
  if (!relay) return false;
  // Not picked up yet: cancelling the ALLOW is enough.
  await db
    .update(deviceCommands)
    .set({ status: "cancelled" })
    .where(and(eq(deviceCommands.deviceId, relay.deviceId), inArray(deviceCommands.status, ["pending", "sent"]), like(deviceCommands.command, `ALLOW=${c.id}\t%`)));
  await replaceCommand(db, relay.deviceId, "REVOKE=", `REVOKE=${c.id}`, `Stop check-in #${c.id} starting the machine`, RELAY_RULES.allowExpiryMinutes * 60_000 * 4, now);
  return true;
}

// ---------- Beacons ----------

export type AccessEntry = { beacon: string; operatorId: number };

/** The ACCESS command for a list of beacons (pure): sorted, with a short version so the device and VS-lab can compare. */
export function accessCommand(entries: AccessEntry[]) {
  const list = [...entries]
    .sort((a, b) => a.beacon.localeCompare(b.beacon))
    .slice(0, RELAY_RULES.maxAccessEntries)
    .map((e) => `${e.beacon}:${e.operatorId}`)
    .join(",");
  const version = createHash("sha256").update(list).digest("hex").slice(0, 8);
  return { version, command: `ACCESS=${version}\t${list}` };
}

/**
 * Operators whose beacon may start this machine: active, with a beacon, approved for the machine (or the machine has
 * no approval list), and holding any required training (a certification that grants access counts as approved).
 */
export async function accessEntries(db: Db, m: Pick<Machine, "id" | "organizationId" | "categoryId">, now = new Date()): Promise<AccessEntry[]> {
  const [ops, approved, scheduled] = await Promise.all([
    db
      .select({ id: operators.id, beacon: operators.beaconName })
      .from(operators)
      .where(and(eq(operators.organizationId, m.organizationId), eq(operators.active, true), isNull(operators.erasedAt), isNotNull(operators.beaconName))),
    db.select({ operatorId: machineOperators.operatorId }).from(machineOperators).where(eq(machineOperators.machineId, m.id)),
    scheduledAccess(db, m.organizationId, m.id, now),
  ]);
  const out: AccessEntry[] = [];
  for (const op of ops) {
    const training = await trainingAccess(db, m.organizationId, m, op.id, now);
    if (training.missing.length) continue;
    const ok = approved.length === 0 || approved.some((a) => a.operatorId === op.id) || scheduled.includes(op.id) || training.granted;
    if (ok) out.push({ beacon: op.beacon!, operatorId: op.id });
  }
  return out;
}

/**
 * Sends the machine's beacon list when it has changed, or when the device hasn't got the current one (new device,
 * command expired). Returns true when a command was queued.
 */
export async function syncAccessList(db: Db, machineId: number, now = new Date()) {
  const relay = await relayDevice(db, machineId);
  if (!relay) return false;
  const { version, command } = accessCommand(await accessEntries(db, relay.machine, now));
  const [last] = await db
    .select({ command: deviceCommands.command, status: deviceCommands.status })
    .from(deviceCommands)
    .where(and(eq(deviceCommands.deviceId, relay.deviceId), like(deviceCommands.command, "ACCESS=%")))
    .orderBy(desc(deviceCommands.id))
    .limit(1);
  if (last && last.command.startsWith(`ACCESS=${version}\t`) && ["pending", "sent", "done"].includes(last.status)) return false;
  const count = command.split("\t")[1] ? command.split("\t")[1].split(",").length : 0;
  await replaceCommand(db, relay.deviceId, "ACCESS=", command, `Beacon list: ${count} operator${count === 1 ? "" : "s"}`, RELAY_RULES.accessExpiryDays * 86_400_000, now);
  return true;
}

/** Every relay machine's beacon list (watchdog, every 5 minutes; and after approvals or operators change). */
export async function syncAccessLists(db: Db, now = new Date(), organizationId?: number) {
  const rows = await db
    .select({ id: machines.id })
    .from(machines)
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(and(eq(machines.tier, "control"), organizationId ? eq(machines.organizationId, organizationId) : undefined));
  let sent = 0;
  for (const r of rows) if (await syncAccessList(db, r.id, now)) sent++;
  return sent;
}

/** The device answered: an ALLOW it acted on, or the beacon list it now holds. */
export async function confirmRelayAnswer(db: Db, deviceId: string, command: string, ok: boolean, now = new Date()) {
  if (!ok) return;
  if (command.startsWith("ALLOW=")) {
    const id = Number(command.slice(6).split("\t")[0]);
    if (Number.isSafeInteger(id)) await db.update(checkins).set({ relayAllowedAt: now }).where(and(eq(checkins.id, id), isNull(checkins.relayAllowedAt)));
  } else if (command.startsWith("ACCESS=")) {
    const [pairing] = await db
      .select({ machineId: deviceAssignments.machineId })
      .from(deviceAssignments)
      .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endedAt)));
    if (pairing) await db.update(machines).set({ accessListHash: command.slice(7).split("\t")[0] }).where(eq(machines.id, pairing.machineId));
  }
}

export class RelayError extends Error {}

/**
 * The device let an operator start with their beacon: a check-in (method "ble", no checklist, so the "checklist
 * due" beeps follow until they do one with the QR code). Repeats for the same operator while it's open are ignored.
 * Returns the check-in id.
 */
export async function beaconCheckIn(db: Db, deviceId: string, input: { operatorId: number; beacon: string; at: Date }, now = new Date()) {
  const relay = await relayDevice(db, (await pairedMachineId(db, deviceId)) ?? -1);
  if (!relay) throw new RelayError("Not a relay machine");
  const m = relay.machine;
  const [op] = await db
    .select()
    .from(operators)
    .where(and(eq(operators.id, input.operatorId), eq(operators.organizationId, m.organizationId), isNull(operators.erasedAt)));
  // b=APP: the operator app's pass (src/lib/operator-app.ts) rather than a beacon.
  const viaApp = input.beacon.toUpperCase() === "APP";
  if (!op || (!viaApp && op.beaconName !== input.beacon.toUpperCase())) throw new RelayError("Unknown operator or beacon");
  const at = new Date(Math.min(now.getTime(), Math.max(input.at.getTime(), now.getTime() - RELAY_RULES.maxReportDelayHours * 3_600_000)));
  await syncCheckins(db, m.id, now);
  const [open] = await db
    .select({ id: checkins.id, operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.machineId, m.id), isNull(checkins.endedAt)));
  if (open?.operatorId === op.id) return open.id;
  return db.transaction(async (tx) => {
    await tx
      .update(checkins)
      .set({ endedAt: at, endReason: "replaced" })
      .where(and(eq(checkins.machineId, m.id), isNull(checkins.endedAt)));
    await tx
      .update(checkins)
      .set({ endedAt: at, endReason: "moved" })
      .where(and(eq(checkins.operatorId, op.id), isNull(checkins.endedAt)));
    const [row] = await tx
      .insert(checkins)
      .values({
        organizationId: m.organizationId,
        machineId: m.id,
        operatorId: op.id,
        startedAt: at,
        authorized: true,
        checklistOk: true,
        answers: [],
        // The beacon was within reach of the device: the operator was at the machine.
        locationCheck: "near",
        method: viaApp ? "app" : "ble",
        relayAllowedAt: at,
      })
      .returning({ id: checkins.id });
    return row.id;
  });
}

async function pairedMachineId(db: Db, deviceId: string) {
  const [p] = await db
    .select({ machineId: deviceAssignments.machineId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endedAt)));
  return p?.machineId ?? null;
}

