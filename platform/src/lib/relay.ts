import { createHash } from "node:crypto";
import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, like, lte } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { checkins, deviceAssignments, deviceCommands, engineSessions, machineOperators, machines, operators, type Machine } from "@/lib/db/schema";
import { effectiveMode } from "@/lib/modes";
import { CHECKIN_RULES, cleanBeaconName, endOpenCheckins, syncCheckins } from "@/lib/operators";
import { scheduledAccess } from "@/lib/schedules";
import { trainingAccess } from "@/lib/training";

/**
 * Safety & Access Control: the starter relay (docs/starter-relay.md; Craig 2026-10-26, modelled on Veristart's
 * production firmware 4.2.11, which closes a relay on the Freematics external socket, GPIO26, for authorized
 * operators). The device decides on the spot; VS-lab tells it what it needs to know, as device commands:
 *  - MODE=<mode>…: Access-Controlled / Unlocked / Locked (src/lib/modes.ts; a repair lockout counts as Locked).
 *  - ALLOW=<check-in id>\t<start minutes>\t<break minutes>\t<hold minutes>\t<operator id>: an approved operator checked
 *    in (QR code or app): close the relay until they start (or the start window passes), keep it closed while running
 *    and for the break allowance after it stops. Hold minutes (app check-ins, 0 = none): the session hold, during
 *    which only that operator's phone can close the relay again (it proves itself over Bluetooth; the device reports
 *    the resume at /hub/api/access/<device>?c=<check-in id>). App check-ins with a hold get no free break.
 *  - REVOKE=<check-in id>: that check-in ended (a manager ended it, the operator was deactivated): open the relay.
 *  - ACCESS=<version>\t<beacon>:<operator id>,…: the operators whose Bluetooth beacon may start this machine without
 *    signal. A beacon is a MAC address (AA:BB:CC:DD:EE:FF) or a broadcast name; the operator id follows the last colon. The device reports a beacon start at /hub/api/access/<device> (a beacon check-in, method "ble").
 * Only machines on the Safety & Access Control tier (`control`) with a paired device get the relay commands. Beacons
 * also work on Safety & Access Monitoring (`monitor`; Craig 2026-10-30: a beacon replicates a check-in, whether the
 * machine is access-controlled or access-monitored): those machines get an ACCESS list of every operator with a
 * beacon, and a beacon near the device becomes a check-in, flagged "not approved" like a QR check-in would be.
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

/** The paired device of a machine that uses beacons (Safety & Access Monitoring or Control), or null. */
async function beaconDevice(db: Db, machineId: number) {
  const [row] = await db
    .select({ machine: machines, deviceId: deviceAssignments.deviceId })
    .from(machines)
    .innerJoin(deviceAssignments, and(eq(deviceAssignments.machineId, machines.id), isNull(deviceAssignments.endedAt)))
    .where(eq(machines.id, machineId));
  return row && BEACON_TIERS.includes(row.machine.tier) ? row : null;
}
const BEACON_TIERS: Machine["tier"][] = ["monitor", "control"];

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
  // Already let in (a start the device reported itself, a resume): nothing to send.
  if (!c || (c.method !== "web" && c.method !== "app") || c.relayAllowedAt) return false;
  const relay = await relayDevice(db, c.machineId);
  if (!relay || !shouldAllow(relay.machine, c, now.getTime())) return false;
  await replaceCommand(
    db,
    relay.deviceId,
    "ALLOW=",
    `ALLOW=${c.id}\t${CHECKIN_RULES.engineStartWindowMinutes}\t${c.holdMinutes ? 0 : (CHECKIN_RULES.breakMinutes[c.method] ?? 0)}\t${c.holdMinutes ?? 0}\t${c.operatorId}`,
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

/** Approved for the machine: no approval list, on it, scheduled access, or a certification that grants access. */
async function approvedFor(db: Db, m: Pick<Machine, "id" | "organizationId" | "categoryId">, operatorId: number, now: Date) {
  const approved = await db.select({ operatorId: machineOperators.operatorId }).from(machineOperators).where(eq(machineOperators.machineId, m.id));
  if (approved.length === 0 || approved.some((a) => a.operatorId === operatorId)) return true;
  if ((await scheduledAccess(db, m.organizationId, m.id, now)).includes(operatorId)) return true;
  return (await trainingAccess(db, m.organizationId, m, operatorId, now)).granted;
}

/**
 * The machine's beacon list: active operators with a beacon who hold any required training. On Safety & Access
 * Control only those approved for the machine (or it has no approval list; a certification that grants access
 * counts): their beacon closes the relay. On Safety & Access Monitoring everyone, so an unapproved operator's check-in
 * is recorded and flagged, as with the QR code.
 */
export async function accessEntries(db: Db, m: Pick<Machine, "id" | "organizationId" | "categoryId" | "tier">, now = new Date()): Promise<AccessEntry[]> {
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
    const ok = m.tier !== "control" || approved.length === 0 || approved.some((a) => a.operatorId === op.id) || scheduled.includes(op.id) || training.granted;
    if (ok) out.push({ beacon: op.beacon!, operatorId: op.id });
  }
  return out;
}

/**
 * Sends the machine's beacon list when it has changed, or when the device hasn't got the current one (new device,
 * command expired). Returns true when a command was queued.
 */
export async function syncAccessList(db: Db, machineId: number, now = new Date()) {
  const relay = await beaconDevice(db, machineId);
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
    .where(and(inArray(machines.tier, BEACON_TIERS), organizationId ? eq(machines.organizationId, organizationId) : undefined));
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
  const relay = await beaconDevice(db, (await pairedMachineId(db, deviceId)) ?? -1);
  if (!relay) throw new RelayError("Not a machine that uses beacons");
  const m = relay.machine;
  const [op] = await db
    .select()
    .from(operators)
    .where(and(eq(operators.id, input.operatorId), eq(operators.organizationId, m.organizationId), isNull(operators.erasedAt)));
  // b=APP: the operator app's pass (src/lib/operator-app.ts) rather than a beacon.
  const viaApp = input.beacon.toUpperCase() === "APP";
  // The device reports the beacon as it's on the list (a MAC with colons, or a name); normalized the same way here.
  const beacon = cleanBeaconName(input.beacon);
  if (!op || (!viaApp && (typeof beacon !== "string" || op.beaconName !== beacon))) throw new RelayError("Unknown operator or beacon");
  const at = new Date(Math.min(now.getTime(), Math.max(input.at.getTime(), now.getTime() - RELAY_RULES.maxReportDelayHours * 3_600_000)));
  await syncCheckins(db, m.id, now);
  const [open] = await db
    .select({ id: checkins.id, operatorId: checkins.operatorId })
    .from(checkins)
    .where(and(eq(checkins.machineId, m.id), isNull(checkins.endedAt)));
  if (open?.operatorId === op.id) return open.id;
  const authorized = await approvedFor(db, m, op.id, at);
  return db.transaction(async (tx) => {
    await endOpenCheckins(tx, eq(checkins.machineId, m.id), "replaced", at);
    await endOpenCheckins(tx, eq(checkins.operatorId, op.id), "moved", at);
    const [row] = await tx
      .insert(checkins)
      .values({
        organizationId: m.organizationId,
        machineId: m.id,
        operatorId: op.id,
        startedAt: at,
        authorized,
        checklistOk: true,
        answers: [],
        // The beacon was within reach of the device: the operator was at the machine.
        locationCheck: "near",
        method: viaApp ? "app" : "ble",
        // Only a relay machine's device closed its relay for it.
        relayAllowedAt: m.tier === "control" ? at : null,
      })
      .returning({ id: checkins.id });
    return row.id;
  });
}

/**
 * Session hold: the device says the operator's phone proved itself after a break and the relay closed again for
 * check-in `checkinId` (docs/operator-app.md). The check-in carries on: counted as a resume, and reopened if VS-lab had
 * already ended it (the report came late, after the hold ran out here). Anything that doesn't fit (another operator's
 * check-in since, not a held check-in) is recorded as an app start instead, like an offline pass. Returns the
 * check-in id.
 */
export async function resumeCheckIn(db: Db, deviceId: string, input: { operatorId: number; checkinId: number; at: Date }, now = new Date()) {
  const machineId = await pairedMachineId(db, deviceId);
  const at = new Date(Math.min(now.getTime(), Math.max(input.at.getTime(), now.getTime() - RELAY_RULES.maxReportDelayHours * 3_600_000)));
  const [c] = machineId ? await db.select().from(checkins).where(and(eq(checkins.id, input.checkinId), eq(checkins.machineId, machineId))) : [];
  const fallback = () => beaconCheckIn(db, deviceId, { operatorId: input.operatorId, beacon: "APP", at }, now);
  if (!c || c.operatorId !== input.operatorId || !c.holdMinutes || at < c.startedAt) return fallback();
  if (c.endedAt) {
    // Ended by VS-lab while the device still held it: only "engine stopped", within the hold, nobody else since.
    const [later] = await db
      .select({ id: checkins.id })
      .from(checkins)
      .where(and(eq(checkins.machineId, c.machineId), gt(checkins.startedAt, c.startedAt)))
      .limit(1);
    if (c.endReason !== "engine stopped" || later || at.getTime() > c.endedAt.getTime() + c.holdMinutes * 60_000) return fallback();
    // Link it to the engine run that followed, so it ends when that one does.
    const [next] = await db
      .select({ id: engineSessions.id })
      .from(engineSessions)
      .where(
        and(
          eq(engineSessions.machineId, c.machineId),
          gte(engineSessions.startedAt, new Date(at.getTime() - 60_000)),
          lte(engineSessions.startedAt, new Date(at.getTime() + CHECKIN_RULES.engineStartWindowMinutes * 60_000)),
        ),
      )
      .orderBy(engineSessions.startedAt)
      .limit(1);
    await db
      .update(checkins)
      .set({ endedAt: null, endReason: null, ...(next && { engineSessionId: next.id }) })
      .where(eq(checkins.id, c.id));
  }
  // The device resends a report it got no answer to: count each resume once.
  if (c.lastResumedAt?.getTime() !== at.getTime()) {
    await db
      .update(checkins)
      .set({ resumeCount: c.resumeCount + 1, lastResumedAt: at, relayAllowedAt: c.relayAllowedAt ?? at })
      .where(eq(checkins.id, c.id));
  }
  await syncCheckins(db, c.machineId, now);
  return c.id;
}

async function pairedMachineId(db: Db, deviceId: string) {
  const [p] = await db
    .select({ machineId: deviceAssignments.machineId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endedAt)));
  return p?.machineId ?? null;
}

