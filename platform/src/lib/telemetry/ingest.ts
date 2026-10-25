import { and, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import { deviceAssignments, deviceEvents, devices, engineSessions, machines, telemetry, type EngineSession } from "@/lib/db/schema";
import { num, type SampleFields } from "@/lib/freematics/protocol";
import { recordEvent as recordNotification } from "@/lib/notifications";
import { checkMovement, noteContact } from "@/lib/tamper";
import { checkDwell, updatePresence } from "@/lib/worksites";
import { checkBattery } from "@/lib/battery";
import { updateEngineData } from "@/lib/faults";
import { checkSpeedAndIdle } from "@/lib/safety";
import { detectEngine, ENGINE_THRESHOLDS, type EngineReading } from "./engine";
import { SAMPLE_TIME_RULES, sampleTimes } from "./sample-time";

const DEVICE_ID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

export function isValidDeviceId(id: string): boolean {
  return DEVICE_ID_PATTERN.test(id);
}

/**
 * When false, data from devices that are not already in the database is rejected.
 * Default true so a new device shows up as soon as it reports. Set DEVICE_AUTO_REGISTER=false
 * once your devices are registered.
 */
export function autoRegisterEnabled(): boolean {
  return process.env.DEVICE_AUTO_REGISTER !== "false";
}

export class UnknownDeviceError extends Error {}

async function ensureDevice(db: Db, deviceId: string, autoRegister: boolean) {
  if (autoRegister) {
    await db.insert(devices).values({ id: deviceId }).onConflictDoNothing();
    return;
  }
  const existing = await db.select({ id: devices.id }).from(devices).where(eq(devices.id, deviceId));
  if (existing.length === 0) throw new UnknownDeviceError(deviceId);
}

/** The machine this device is currently paired with, or null (in stock, on the bench, unpaired). */
export async function pairedMachineId(db: Db, deviceId: string): Promise<number | null> {
  const [row] = await db
    .select({ machineId: deviceAssignments.machineId })
    .from(deviceAssignments)
    .where(and(eq(deviceAssignments.deviceId, deviceId), isNull(deviceAssignments.endedAt)));
  return row?.machineId ?? null;
}

/** The device's state before this report, for the tamper checks (null for a brand-new device). */
async function stateBefore(db: Db, deviceId: string) {
  const [row] = await db.select({ lastSeenAt: devices.lastSeenAt, vin: devices.vin }).from(devices).where(eq(devices.id, deviceId));
  return row ?? null;
}

/** Tamper checks for a report on a paired device. A problem here must never stop the device getting its HTTP 200. */
/** Tamper and worksite checks must never stop the device's data being saved, or its HTTP 200. */
async function sideCheck(label: string, run: () => Promise<unknown>) {
  try {
    await run();
  } catch (err) {
    console.error(`${label} failed`, err);
  }
}
const tamperChecks = (run: () => Promise<unknown>) => sideCheck("Tamper check", run);

function validFix(lat: number | null, lng: number | null): lat is number {
  return (
    lat !== null && lng !== null && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0)
  );
}

/**
 * Stores a batch of samples from a device. The data belongs to the machine the device is paired with
 * (if any): rows are stamped with that machine, and the machine's snapshot and engine sessions are
 * updated. The device keeps its own snapshot too, for diagnostics. Samples are dated by when they were taken
 * (sample-time.ts) and handled oldest first.
 */
export async function ingestSamples(
  db: Db,
  deviceId: string,
  received: SampleFields[],
  opts: { autoRegister?: boolean; now?: Date } = {},
): Promise<number> {
  const now = opts.now ?? new Date();
  const before = await stateBefore(db, deviceId);
  await ensureDevice(db, deviceId, opts.autoRegister ?? autoRegisterEnabled());
  const machineId = await pairedMachineId(db, deviceId);
  if (machineId) await tamperChecks(() => noteContact(db, { deviceId, machineId, before, now }));
  if (received.length === 0) {
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, deviceId));
    if (machineId) await db.update(machines).set({ lastSeenAt: now }).where(eq(machines.id, machineId));
    return 0;
  }

  // Oldest first, by when each sample was taken: Telelogger sends late (backlogged) readings newest first.
  const times = sampleTimes(received, now);
  const order = received.map((_, i) => i).sort((a, b) => times[a].getTime() - times[b].getTime() || a - b);
  const samples = order.map((i) => received[i]);
  const recordedAt = order.map((i) => times[i]);
  // An upload of only old readings (a backlog sent after a dead zone) is history: it's stored, but doesn't move
  // the machine's current position or change its engine state, worksite, safety or battery checks.
  const live = now.getTime() - recordedAt[recordedAt.length - 1].getTime() <= SAMPLE_TIME_RULES.lateMs;

  const readings = samples.map(detectEngine);
  const rows = samples.map((f, i) => {
    const lat = num(f, "lat");
    const lng = num(f, "lng");
    const hasFix = validFix(lat, lng);
    const centivolts = num(f, "batteryCentivolts");
    return {
      deviceId,
      machineId,
      receivedAt: now,
      recordedAt: recordedAt[i],
      deviceMs: num(f, "deviceMs"),
      lat: hasFix ? lat : null,
      lng: hasFix ? lng : null,
      altitudeM: num(f, "altitudeM"),
      speedKph: num(f, "speedKph"),
      heading: num(f, "heading"),
      satellites: num(f, "satellites"),
      batteryV: centivolts === null ? null : centivolts / 100,
      rssi: num(f, "rssi"),
      deviceTempC: num(f, "deviceTempC"),
      engineOn: readings[i].running,
      fields: f,
    };
  });
  await db.insert(telemetry).values(rows);
  if (!live) {
    await db.update(devices).set({ lastSeenAt: now }).where(eq(devices.id, deviceId));
    if (machineId) await db.update(machines).set({ lastSeenAt: now }).where(eq(machines.id, machineId));
    return rows.length;
  }

  // Update the "latest" snapshots. Each value keeps its previous value
  // if this batch didn't include it (e.g. no GPS fix indoors).
  const latest = <K extends keyof (typeof rows)[number]>(key: K) =>
    rows.findLast((r) => r[key] !== null)?.[key] ?? null;
  const lastFix = rows.findLast((r) => r.lat !== null);
  const fix = lastFix ? { lastFixAt: now, lastLat: lastFix.lat, lastLng: lastFix.lng } : {};

  await db
    .update(devices)
    .set({
      lastSeenAt: now,
      ...fix,
      lastSpeedKph: sql`coalesce(${latest("speedKph")}, ${devices.lastSpeedKph})`,
      lastBatteryV: sql`coalesce(${latest("batteryV")}, ${devices.lastBatteryV})`,
      lastRssi: sql`coalesce(${latest("rssi")}, ${devices.lastRssi})`,
    })
    .where(eq(devices.id, deviceId));
  if (machineId) {
    await db
      .update(machines)
      .set({
        lastSeenAt: now,
        ...fix,
        lastSpeedKph: sql`coalesce(${latest("speedKph")}, ${machines.lastSpeedKph})`,
        lastBatteryV: sql`coalesce(${latest("batteryV")}, ${machines.lastBatteryV})`,
        lastRssi: sql`coalesce(${latest("rssi")}, ${machines.lastRssi})`,
      })
      .where(eq(machines.id, machineId));
  }

  // The newest sample with a reading decides the engine state, if it's recent: older readings in the same upload
  // (a backlog) are history and mustn't restart or extend an engine-on period now.
  const recentFrom = now.getTime() - SAMPLE_TIME_RULES.lateMs;
  const lastIndex = readings.findLastIndex((r, i) => r.running !== null && recordedAt[i].getTime() >= recentFrom);
  const lastReading = lastIndex >= 0 ? readings[lastIndex] : undefined;
  // When the engine state was taken (not when it arrived), and for a start, the first of the recent running readings
  // leading up to it, so engine-on periods begin and end at reading times.
  let firstRunning = lastIndex;
  while (lastReading?.running && firstRunning > 0) {
    const r = readings[firstRunning - 1];
    if (recordedAt[firstRunning - 1].getTime() < recentFrom || r.running === false) break;
    firstRunning--;
  }
  const readingTimes = lastIndex >= 0 ? { at: recordedAt[lastIndex], since: recordedAt[Math.max(0, firstRunning)] } : null;
  if (machineId && lastFix) {
    await tamperChecks(() => checkMovement(db, machineId, { lat: lastFix.lat!, lng: lastFix.lng! }, now));
    // Worksites: entered / left / stayed too long (notifications are sent after the reply, in alert-jobs).
    await sideCheck("Worksite check", async () => {
      const [m] = await db.select({ organizationId: machines.organizationId }).from(machines).where(eq(machines.id, machineId));
      if (!m) return;
      await updatePresence(db, { id: machineId, organizationId: m.organizationId }, { lat: lastFix.lat!, lng: lastFix.lng!, satellites: lastFix.satellites }, now);
      await checkDwell(db, now, machineId);
    });
  }

  if (lastReading) {
    const [prev] = await db.select({ engineOn: devices.engineOn }).from(devices).where(eq(devices.id, deviceId));
    if (prev?.engineOn !== lastReading.running) {
      await db.update(devices).set({ engineOn: lastReading.running, engineChangedAt: now }).where(eq(devices.id, deviceId));
    }
    // Engine-on periods (and so engine hours, check-ins and alerts) belong to the machine.
    if (machineId) await updateEngineState(db, machineId, lastReading, now, readingTimes!);
  }

  // Uploads with no engine signal (e.g. GPS only) leave the state alone, but note since when, so pages can
  // show the engine as unknown once nothing has confirmed it for a while (engineStatus).
  if (machineId) {
    if (lastReading) {
      await db
        .update(machines)
        .set({ engineUnknownSince: null })
        .where(and(eq(machines.id, machineId), isNotNull(machines.engineUnknownSince)));
    } else {
      await db
        .update(machines)
        .set({ engineUnknownSince: now })
        .where(and(eq(machines.id, machineId), isNull(machines.engineUnknownSince)));
    }
  }

  // Engine computer data (J1939): hour meter and fault codes.
  if (machineId) await sideCheck("Engine data", () => updateEngineData(db, machineId, samples, now));

  // Safety: speeding (fleet / worksite limits) and excessive idling. Runs after the worksite check so
  // a site's own speed limit applies as soon as the machine is in it.
  if (machineId) {
    await sideCheck("Safety check", () =>
      checkSpeedAndIdle(
        db,
        machineId,
        rows.map((r, i) => ({
          speedKph: r.speedKph,
          satellites: r.satellites,
          rpm: num(samples[i], "j1939Rpm") ?? num(samples[i], "obdRpm"),
          engineOn: readings[i].running,
        })),
        now,
        before?.lastSeenAt ?? null,
      ),
    );
  }

  // Low battery warning (engine-off readings only).
  if (machineId) {
    await sideCheck("Battery check", () =>
      checkBattery(db, machineId, rows.map((r, i) => ({ volts: r.batteryV, engineOn: readings[i].running })), now),
    );
  }

  return rows.length;
}

/**
 * Keeps the machine's engine session table in step with the latest reading:
 *  - running, no open session      → open one
 *  - running, open session         → extend it
 *  - stopped, open session         → close it
 *  - open session gone stale (no report > staleMinutes) → close it at its last report first
 * Each start and stop is recorded as a notification event; alert-jobs delivers them after the response.
 */
async function updateEngineState(db: Db, machineId: number, reading: EngineReading, now: Date, times: { at: Date; since: Date }) {
  const openWhere = and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt));
  let open: EngineSession | undefined = (await db.select().from(engineSessions).where(openWhere))[0];
  const [{ organizationId }] = await db.select({ organizationId: machines.organizationId }).from(machines).where(eq(machines.id, machineId));
  const engineEvent = (type: "start" | "stop", sessionId: number, at: Date) =>
    recordNotification(db, { organizationId, machineId, type, engineSessionId: sessionId, occurredAt: at });

  const staleMs = ENGINE_THRESHOLDS.staleMinutes * 60_000;
  if (open && now.getTime() - open.lastSeenAt.getTime() > staleMs) {
    await db.update(engineSessions).set({ endedAt: open.lastSeenAt }).where(eq(engineSessions.id, open.id));
    await engineEvent("stop", open.id, open.lastSeenAt);
    open = undefined;
  }

  // Times are when the readings were taken: a start at the first running reading, a stop at the last one that showed
  // the engine running (the moment it stopped is between that and the first "off" reading).
  let changedAt = times.at;
  if (reading.running) {
    if (open) {
      if (times.at > open.lastSeenAt) await db.update(engineSessions).set({ lastSeenAt: times.at }).where(eq(engineSessions.id, open.id));
    } else {
      // The unique index allows only one open session; a simultaneous upload may have opened it already.
      const [started] = await db
        .insert(engineSessions)
        .values({ machineId, startedAt: times.since, lastSeenAt: times.at, source: reading.source })
        .onConflictDoNothing()
        .returning({ id: engineSessions.id });
      if (started) await engineEvent("start", started.id, times.since);
      changedAt = times.since;
    }
  } else if (open) {
    await db.update(engineSessions).set({ endedAt: open.lastSeenAt }).where(eq(engineSessions.id, open.id));
    await engineEvent("stop", open.id, open.lastSeenAt);
    changedAt = open.lastSeenAt;
  }

  // engineChangedAt marks when the current state began ("running since 9:42").
  // It moves when the state flips, or when a new running session starts after a stale one.
  const [prev] = await db.select({ engineOn: machines.engineOn }).from(machines).where(eq(machines.id, machineId));
  const startedNewSession = reading.running && !open;
  if (prev?.engineOn !== reading.running || startedNewSession) {
    await db.update(machines).set({ engineOn: reading.running, engineChangedAt: changedAt }).where(eq(machines.id, machineId));
  }
}

export async function recordEvent(
  db: Db,
  deviceId: string,
  event: { type: string; rssi?: number | null; vin?: string | null },
  opts: { autoRegister?: boolean; now?: Date } = {},
) {
  const now = opts.now ?? new Date();
  const before = await stateBefore(db, deviceId);
  await ensureDevice(db, deviceId, opts.autoRegister ?? autoRegisterEnabled());
  const machineId = await pairedMachineId(db, deviceId);
  // Before the event is stored, so "the previous event" is the one before this.
  if (machineId) {
    await tamperChecks(() => noteContact(db, { deviceId, machineId, before, eventType: event.type, vin: event.vin, now }));
  }
  await db.insert(deviceEvents).values({
    deviceId,
    machineId,
    at: now,
    type: event.type,
    rssi: event.rssi ?? null,
    detail: event.vin ? `VIN ${event.vin}` : null,
  });
  await db
    .update(devices)
    .set({
      lastSeenAt: now,
      ...(event.rssi != null && { lastRssi: event.rssi }),
      ...(event.vin && { vin: event.vin }),
    })
    .where(eq(devices.id, deviceId));
  if (machineId) {
    await db
      .update(machines)
      .set({ lastSeenAt: now, ...(event.rssi != null && { lastRssi: event.rssi }) })
      .where(eq(machines.id, machineId));
    // Telelogger signs off only when it goes to sleep (parked), and pings carry no engine data: so a sign-off ends
    // the engine-on period, and a ping ends one nothing has confirmed for a while.
    await endQuietEngineSessions(db, now, { machineId, signedOff: event.type === "logout" });
  }
}

/**
 * Ends engine-on periods that no reading has confirmed for ENGINE_THRESHOLDS.staleMinutes (or straight away when
 * the device signed off), at the last running reading, and shows the engine as off. Without this a parked machine
 * whose device sleeps and pings stays "Running" (and its operator checked in). From device events and the watchdog.
 * Returns the machines whose engine period was ended.
 */
export async function endQuietEngineSessions(db: Db, now: Date, opts: { machineId?: number; signedOff?: boolean } = {}) {
  const cutoff = opts.signedOff ? now : new Date(now.getTime() - ENGINE_THRESHOLDS.staleMinutes * 60_000);
  const quiet = await db
    .select({ session: engineSessions, organizationId: machines.organizationId })
    .from(engineSessions)
    .innerJoin(machines, eq(machines.id, engineSessions.machineId))
    .where(
      and(
        isNull(engineSessions.endedAt),
        lte(engineSessions.lastSeenAt, cutoff),
        opts.machineId ? eq(engineSessions.machineId, opts.machineId) : undefined,
      ),
    );
  const ended: number[] = [];
  for (const { session, organizationId } of quiet) {
    const done = await db
      .update(engineSessions)
      .set({ endedAt: session.lastSeenAt })
      .where(and(eq(engineSessions.id, session.id), isNull(engineSessions.endedAt)))
      .returning({ id: engineSessions.id });
    if (!done.length) continue;
    await recordNotification(db, { organizationId, machineId: session.machineId, type: "stop", engineSessionId: session.id, occurredAt: session.lastSeenAt });
    await db
      .update(machines)
      .set({ engineOn: false, engineChangedAt: session.lastSeenAt })
      .where(and(eq(machines.id, session.machineId), eq(machines.engineOn, true)));
    ended.push(session.machineId);
  }
  return ended;
}
