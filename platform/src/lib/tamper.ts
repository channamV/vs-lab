import { and, desc, eq, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import { RESTART_REASONS, restartReason } from "@/lib/restart-reasons";
import { orgTimeZone, orgTimeZones } from "@/lib/org-time";
import type { Db } from "@/lib/db";
import {
  alerts,
  deviceAssignments,
  deviceEvents,
  deviceIncidents,
  devices,
  machines,
  type Alert,
} from "@/lib/db/schema";
import { isArmed, isMonitored } from "@/lib/alerts";
import { ENGINE_THRESHOLDS } from "@/lib/telemetry/engine";
import { effectiveMode } from "@/lib/modes";
import { distanceMeters } from "@/lib/operators";
import { clockTime, machineLabel } from "@/lib/format";
import { recordEvent } from "@/lib/notifications";
import { localHour } from "@/lib/telemetry/engine";

/**
 * Tamper and connectivity watchdog.
 *
 * What the stock Telelogger firmware does (firmware_v5/telelogger): while the machine runs it reports
 * every 1–5 s; after ~3 minutes standing still it signs off ("logout") and sleeps; asleep, it wakes every
 * 15 minutes to contact us (PING_BACK_INTERVAL). Unplugged or with its power cut, it simply stops.
 * So a healthy device is never quiet for much more than 15 minutes, and how it went quiet says a lot.
 *
 *  - watchdog(): run every 5 minutes (Vercel Cron → /api/jobs/watchdog). Opens or re-scores an incident
 *    for each paired device that's quieter than expected, with a concern level and reasons.
 *  - noteContact(): run as each report is stored. Closes the quiet spell, and spots a device that came back
 *    reporting a different vehicle (VIN) or restarted without signing off (power interrupted).
 *  - checkMovement(): when the first GPS position after a quiet spell arrives, flags a big jump.
 *  - notifyIncidents(): turns new or escalated incidents into alerts (medium/high) and notifications.
 * Plain functions that take the database, so they can be tested without a server.
 */

export const TAMPER_RULES = {
  /** No sign-off: the device was awake (running or just parked) and stopped mid-stream. */
  abruptQuietMinutes: 10,
  /** Asleep, it should check in every 15 minutes; allow this much slack before counting one as missed. */
  heartbeatMinutes: 15,
  heartbeatGraceMinutes: 5,
  /** At or below this, a quiet spell may just be a coverage gap. */
  weakSignalDbm: -100,
  /** Below this, the machine's battery may simply have run flat. */
  lowBatteryV: 11.8,
  /** Back after a quiet spell this far from where it went quiet → it was moved while silent. */
  movedWhileSilentMeters: 500,
  /** Earlier quiet spells within this distance that ended by themselves → probably a known dead spot. */
  knownGapMeters: 300,
  /** A restart without signing off after at least this gap → power interrupted (unplugged?). */
  powerGapMinutes: 2,
  /** Armed machines outside these local hours are watched more strictly. */
  workdayStartHour: 6,
  workdayEndHour: 19,
};

export type Concern = "low" | "medium" | "high";
const LEVELS: Concern[] = ["low", "medium", "high"];
export const concernRank = (c: string | null | undefined) => (c ? LEVELS.indexOf(c as Concern) : -1);
const shift = (c: Concern, by: number): Concern => LEVELS[Math.max(0, Math.min(2, LEVELS.indexOf(c) + by))];

export const INCIDENT_LABELS: Record<string, string> = {
  silent: "Went quiet",
  "moved-while-silent": "Moved while quiet",
  "vin-changed": "Reporting a different vehicle",
  "power-interrupted": "Power interrupted",
};

export type SilenceInput = {
  now: Date;
  lastContactAt: Date;
  engineWasOn: boolean | null;
  /** The device signed off (normal sleep) before going quiet. */
  signedOff: boolean;
  lastRssi: number | null;
  lastBatteryV: number | null;
  /** Earlier quiet spells near here that ended by themselves. */
  knownGaps: number;
  /** A Safety & Access Monitoring machine that's armed. */
  armed: boolean;
  timeZone: string;
};

/**
 * Is the device quieter than expected, and how worrying is that? Pure, so the rules are easy to test
 * and tune. Returns null while the silence is still normal.
 */
export function scoreSilence(input: SilenceInput): { concern: Concern; reasons: string[] } | null {
  const quietMin = (input.now.getTime() - input.lastContactAt.getTime()) / 60_000;
  const reasons: string[] = [];
  let concern: Concern;
  const at = clockTime(input.lastContactAt, input.timeZone, input.now.getTime());
  if (!input.signedOff) {
    if (quietMin < TAMPER_RULES.abruptQuietMinutes) return null;
    concern = "high";
    reasons.push(
      input.engineWasOn
        ? `Stopped reporting at ${at} while the engine was running, without signing off (like being unplugged)`
        : `Stopped reporting at ${at} without signing off (like being unplugged)`,
    );
  } else {
    const missed = Math.floor((quietMin - TAMPER_RULES.heartbeatGraceMinutes) / TAMPER_RULES.heartbeatMinutes);
    if (missed < 1) return null;
    concern = missed >= 2 ? "high" : "medium";
    reasons.push(
      `Went to sleep normally at ${at}, then missed ${missed === 1 ? "its 15-minute check-in" : `${missed} check-ins (quiet ${Math.round(quietMin)} min)`}`,
    );
  }

  // Things that could explain it: each lowers the concern a step.
  if (input.lastRssi !== null && input.lastRssi <= TAMPER_RULES.weakSignalDbm) {
    concern = shift(concern, -1);
    reasons.push(`Signal was weak (${input.lastRssi} dBm): may be a coverage gap`);
  } else if (input.lastRssi !== null) {
    reasons.push(`Signal was good (${input.lastRssi} dBm)`);
  }
  if (input.lastBatteryV !== null && input.lastBatteryV < ENGINE_THRESHOLDS.machinePowerMinVolts) {
    // USB or a bench supply: says nothing about the machine's battery, so it doesn't explain the silence.
    reasons.push(`Was not on machine power (${input.lastBatteryV.toFixed(1)} V: USB or a bench supply)`);
  } else if (input.lastBatteryV !== null && input.lastBatteryV < TAMPER_RULES.lowBatteryV) {
    concern = shift(concern, -1);
    reasons.push(`Battery was low (${input.lastBatteryV.toFixed(1)} V): may have run flat`);
  } else if (input.lastBatteryV !== null) {
    reasons.push(`Battery was healthy (${input.lastBatteryV.toFixed(1)} V)`);
  }
  if (input.knownGaps > 0) {
    concern = shift(concern, -1);
    reasons.push(`Has gone quiet near here ${input.knownGaps} time${input.knownGaps === 1 ? "" : "s"} before and come back by itself`);
  }
  // Armed and after hours: a step more worrying.
  const hour = localHour(input.lastContactAt, input.timeZone);
  if (input.armed && (hour < TAMPER_RULES.workdayStartHour || hour >= TAMPER_RULES.workdayEndHour)) {
    concern = shift(concern, 1);
    reasons.push("Armed machine, after hours");
  }
  return { concern, reasons };
}

// ---------- Watchdog (every 5 minutes) ----------

/** Opens or re-scores incidents for paired devices that are quieter than expected. Returns how many changed. */
export async function watchdog(db: Db, now = new Date()) {
  const rows = await db
    .select({ device: devices, machine: machines })
    .from(deviceAssignments)
    .innerJoin(devices, eq(devices.id, deviceAssignments.deviceId))
    .innerJoin(machines, eq(machines.id, deviceAssignments.machineId))
    .where(isNull(deviceAssignments.endedAt));
  if (rows.length === 0) return { checked: 0, changed: 0 };
  const [lastEvents, open] = await Promise.all([
    db
      .selectDistinctOn([deviceEvents.deviceId], { deviceId: deviceEvents.deviceId, type: deviceEvents.type, at: deviceEvents.at })
      .from(deviceEvents)
      .where(inArray(deviceEvents.deviceId, rows.map((r) => r.device.id)))
      .orderBy(deviceEvents.deviceId, desc(deviceEvents.at)),
    db
      .select()
      .from(deviceIncidents)
      .where(and(eq(deviceIncidents.kind, "silent"), isNull(deviceIncidents.resolvedAt))),
  ]);
  const lastEvent = new Map(lastEvents.map((e) => [e.deviceId, e]));
  const openByMachine = new Map(open.map((i) => [i.machineId, i]));
  const zoneOf = orgTimeZones(db);
  let changed = 0;

  for (const { device, machine } of rows) {
    const ev = lastEvent.get(device.id);
    const signedOff = ev?.type === "logout" && ev.at.getTime() >= device.lastSeenAt.getTime() - 2000;
    const existing = openByMachine.get(machine.id);
    // Re-scoring an open spell keeps its "known dead spot" finding; a new one looks it up.
    const knownGaps = existing
      ? Number(existing.reasons.some((r) => r.startsWith("Has gone quiet near here")))
      : await knownGapsNear(db, machine.id, device.lastLat, device.lastLng);
    const score = scoreSilence({
      now,
      lastContactAt: device.lastSeenAt,
      engineWasOn: device.engineOn,
      signedOff,
      lastRssi: device.lastRssi,
      lastBatteryV: device.lastBatteryV,
      knownGaps,
      // Access-Controlled monitoring, or Locked on any tier: going quiet is more concerning.
      armed: (isMonitored(machine) && isArmed(machine, now.getTime())) || effectiveMode(machine, now.getTime()).mode === "locked",
      timeZone: await zoneOf(machine.organizationId),
    });
    if (!score) continue;
    if (existing) {
      if (concernRank(score.concern) > concernRank(existing.concern)) {
        await db
          .update(deviceIncidents)
          .set({ concern: score.concern, reasons: score.reasons, updatedAt: now })
          .where(eq(deviceIncidents.id, existing.id));
        changed++;
      }
      continue;
    }
    await db
      .insert(deviceIncidents)
      .values({
        organizationId: machine.organizationId,
        machineId: machine.id,
        deviceId: device.id,
        kind: "silent",
        concern: score.concern,
        reasons: score.reasons,
        lastContactAt: device.lastSeenAt,
        lastRssi: device.lastRssi,
        lastBatteryV: device.lastBatteryV,
        engineWasOn: device.engineOn,
        signedOff,
        lastLat: device.lastLat,
        lastLng: device.lastLng,
        openedAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    changed++;
  }
  return { checked: rows.length, changed };
}

/** Earlier quiet spells of this machine near this spot that ended with the device coming back by itself. */
async function knownGapsNear(db: Db, machineId: number, lat: number | null, lng: number | null) {
  if (lat === null || lng === null) return 0;
  const past = await db
    .select({ lat: deviceIncidents.lastLat, lng: deviceIncidents.lastLng })
    .from(deviceIncidents)
    .where(and(eq(deviceIncidents.machineId, machineId), eq(deviceIncidents.kind, "silent"), isNotNull(deviceIncidents.resolvedAt)))
    .orderBy(desc(deviceIncidents.openedAt))
    .limit(50);
  return past.filter((p) => p.lat !== null && p.lng !== null && distanceMeters({ lat, lng }, { lat: p.lat!, lng: p.lng! }) <= TAMPER_RULES.knownGapMeters).length;
}

// ---------- When a device reports ----------

type Before = { lastSeenAt: Date; vin: string | null };

/**
 * Called by ingest for each report, with the device's state from before it. Ends a quiet spell, and
 * records a device that came back reporting a different vehicle or restarted without signing off.
 */
export async function noteContact(
  db: Db,
  input: {
    deviceId: string;
    machineId: number;
    before: Before | null;
    eventType?: string;
    vin?: string | null;
    /** Our firmware's restart reason on login (src/lib/restart-reasons.ts); null = not reported (stock firmware). */
    restartReason?: string | null;
    now: Date;
  },
) {
  const { deviceId, machineId, before, now } = input;
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) return;
  const [quiet] = await db
    .select()
    .from(deviceIncidents)
    .where(and(eq(deviceIncidents.machineId, machineId), eq(deviceIncidents.kind, "silent"), isNull(deviceIncidents.resolvedAt)));
  if (quiet) {
    const minutes = Math.round((now.getTime() - quiet.lastContactAt.getTime()) / 60_000);
    await db
      .update(deviceIncidents)
      .set({ resolvedAt: now, resolution: `Back online after ${minutes} min quiet.`, updatedAt: now })
      .where(eq(deviceIncidents.id, quiet.id));
  }
  if (!before) return;
  const oneOff = (kind: string, concern: Concern, reasons: string[]) =>
    db.insert(deviceIncidents).values({
      organizationId: machine.organizationId,
      machineId,
      deviceId,
      kind,
      concern,
      reasons,
      lastContactAt: before.lastSeenAt,
      openedAt: now,
      updatedAt: now,
      resolvedAt: now,
      movementChecked: true,
    });

  if (input.vin && before.vin && input.vin !== before.vin) {
    await oneOff("vin-changed", "high", [`The device now reports vehicle ${input.vin}; before it was ${before.vin}. It may have been moved to another machine.`]);
  }
  // A fresh login that didn't follow a sign-off means the device restarted: its power was interrupted.
  // (A quiet spell long enough to be its own incident already covers that.)
  if (input.eventType === "login" && !quiet) {
    const gapMin = (now.getTime() - before.lastSeenAt.getTime()) / 60_000;
    const [previous] = await db
      .select({ type: deviceEvents.type })
      .from(deviceEvents)
      .where(and(eq(deviceEvents.deviceId, deviceId), lt(deviceEvents.at, now)))
      .orderBy(desc(deviceEvents.at))
      .limit(1);
    if (gapMin >= TAMPER_RULES.powerGapMinutes && previous && previous.type !== "logout") {
      const at = `Restarted at ${clockTime(now, await orgTimeZone(db, machine.organizationId), now.getTime())} without signing off, after ${Math.round(gapMin)} min without contact`;
      // Our firmware says why; the device restarting by itself (a crash) is a fault to fix, not tampering.
      const reason = restartReason(input.restartReason);
      const kind = reason ? RESTART_REASONS[reason].kind : "power";
      if (kind === "fault" || kind === "normal") {
        await oneOff("device-restart", "low", [`${at}. The device reports: ${RESTART_REASONS[reason!].label.toLowerCase()}. Not a power cut: see its restart report on the staff device page.`]);
      } else if (kind === "brownout") {
        await oneOff("power-interrupted", "medium", [`${at}: its supply voltage dropped too low (a weak or disconnected battery, or loose wiring).`]);
      } else {
        await oneOff("power-interrupted", "medium", [`${at}: its power was interrupted (unplugged, or the battery was disconnected).`]);
      }
    }
  }
}

/** First GPS position after a quiet spell: a big jump means the machine was moved while it couldn't be seen. */
export async function checkMovement(db: Db, machineId: number, fix: { lat: number; lng: number }, now = new Date()) {
  const [spell] = await db
    .select()
    .from(deviceIncidents)
    .where(
      and(
        eq(deviceIncidents.machineId, machineId),
        eq(deviceIncidents.kind, "silent"),
        isNotNull(deviceIncidents.resolvedAt),
        eq(deviceIncidents.movementChecked, false),
      ),
    )
    .orderBy(desc(deviceIncidents.resolvedAt))
    .limit(1);
  if (!spell) return;
  await db.update(deviceIncidents).set({ movementChecked: true }).where(eq(deviceIncidents.id, spell.id));
  if (spell.lastLat === null || spell.lastLng === null) return;
  const moved = distanceMeters(fix, { lat: spell.lastLat, lng: spell.lastLng });
  if (moved < TAMPER_RULES.movedWhileSilentMeters) return;
  const km = moved >= 1000 ? `${(moved / 1000).toFixed(1)} km` : `${Math.round(moved)} m`;
  await db.insert(deviceIncidents).values({
    organizationId: spell.organizationId,
    machineId,
    deviceId: spell.deviceId,
    kind: "moved-while-silent",
    concern: "high",
    reasons: [`Came back ${km} from where it went quiet: the machine was moved while it couldn't be seen.`],
    lastContactAt: spell.lastContactAt,
    lastLat: spell.lastLat,
    lastLng: spell.lastLng,
    openedAt: now,
    updatedAt: now,
    resolvedAt: now,
    movementChecked: true,
  });
}

// ---------- Alerts and notifications ----------

/**
 * Raises alerts for incidents that are new or more serious (medium and high only; "Possible tamper"),
 * and records Equipment Connectivity Status notifications (went quiet / back online). Returns new alerts,
 * which the caller delivers like any other alert.
 */
export async function notifyIncidents(db: Db, which: { machineId?: number } = {}, now = new Date()): Promise<Alert[]> {
  const pending = await db
    .select({ incident: deviceIncidents, machine: machines })
    .from(deviceIncidents)
    .innerJoin(machines, eq(machines.id, deviceIncidents.machineId))
    .where(
      and(
        which.machineId ? eq(deviceIncidents.machineId, which.machineId) : undefined,
        sql`(${deviceIncidents.offlineNotified} = false
          or (${deviceIncidents.kind} = 'silent' and ${deviceIncidents.resolvedAt} is not null and ${deviceIncidents.onlineNotified} = false)
          or coalesce(${deviceIncidents.alertedConcern}, '') <> ${deviceIncidents.concern})`,
      ),
    );
  const raised: Alert[] = [];
  const zoneOf = orgTimeZones(db);
  for (const { incident: i, machine } of pending) {
    const tz = await zoneOf(machine.organizationId);
    const name = machineLabel(machine);
    if (!i.offlineNotified) {
      if (i.kind === "silent") {
        await recordEvent(db, {
          organizationId: i.organizationId,
          machineId: i.machineId,
          type: "equipment_offline",
          detail: `Tracking device ${i.deviceId} went quiet (last heard ${clockTime(i.lastContactAt, tz, now.getTime())}). Concern: ${i.concern}. ${i.reasons.join(". ")}.`,
          occurredAt: i.openedAt,
        });
      }
      await db.update(deviceIncidents).set({ offlineNotified: true }).where(eq(deviceIncidents.id, i.id));
    }
    if (i.kind === "silent" && i.resolvedAt && !i.onlineNotified) {
      await recordEvent(db, {
        organizationId: i.organizationId,
        machineId: i.machineId,
        type: "equipment_offline",
        detail: `Tracking device ${i.deviceId} is back online. ${i.resolution ?? ""}`,
        occurredAt: i.resolvedAt,
      });
      await db.update(deviceIncidents).set({ onlineNotified: true }).where(eq(deviceIncidents.id, i.id));
    }
    if (concernRank(i.concern) > concernRank(i.alertedConcern)) {
      if (concernRank(i.concern) >= concernRank("medium")) {
        const type = i.alertedConcern ? "tamper-escalated" : "tamper";
        const rows = await db
          .insert(alerts)
          .values({
            organizationId: i.organizationId,
            machineId: i.machineId,
            type,
            incidentId: i.id,
            createdAt: now,
            title: `Possible tamper (${i.concern} concern): ${name}`,
            detail: `${INCIDENT_LABELS[i.kind] ?? i.kind}. ${i.reasons.join(". ")}.${i.resolvedAt && i.kind === "silent" ? ` ${i.resolution}` : ""}`,
          })
          .onConflictDoNothing()
          .returning();
        raised.push(...rows);
      }
      await db.update(deviceIncidents).set({ alertedConcern: i.concern }).where(eq(deviceIncidents.id, i.id));
    }
  }
  return raised;
}

