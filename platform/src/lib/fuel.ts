import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { orgTimeZone } from "@/lib/org-time";
import type { Db } from "@/lib/db";
import { alerts, engineSessions, fuelEvents, machines, telemetry, type Alert, type EngineSession, type Machine } from "@/lib/db/schema";
import { clockTime, formatHours, machineLabel } from "@/lib/format";
import { recordEvent } from "@/lib/notifications";

/**
 * Fuel: the refuelling log, and two theft checks. Fuel level is only reported while the ignition is on
 * (from the engine computer: J1939 SPN 96, or OBD-II PID 2F). Medians of several readings smooth out fuel
 * slosh and sensor noise. See docs/alerts.md.
 *
 * 1. At each engine start, once the level has settled: compare it with the last readings before the stop.
 *    Lower → "Possible fuel theft" (taken while parked). Higher → a refuel while parked.
 * 2. While running, every few minutes, against a reference point (the "anchor"):
 *    - the level rose → a refuel while running;
 *    - J1939 machines with a tank size: the tank lost more than the engine's fuel meter says it burned →
 *      "Possible fuel theft (while running)".
 * Refuels and suspected thefts go in the fuel log (fuel_events).
 */
export const FUEL_RULES = {
  /** A drop of at least this much of the tank raises a theft alert... */
  minDropPct: 5,
  /** ...and, when the tank size is known, at least this many litres. */
  minDropLitres: 20,
  /** A rise of at least this much of the tank is a refuel (and, with the tank size, at least minRefuelLitres). */
  minRefuelPct: 8,
  minRefuelLitres: 20,
  /** Wait this long after a start for the level to settle before comparing. */
  settleMinutes: 2,
  /** Readings used for each median. */
  readings: 5,
  /** Give up on a start that hasn't sent enough fuel readings after this long. */
  giveUpMinutes: 15,
  /** Only compare with a stop within this many days. */
  lookbackDays: 14,
  /** While running: how often to check, and how long a reference point lasts before it's renewed. */
  runCheckMinutes: 5,
  anchorMaxMinutes: 60,
};

const FUEL_LEVEL = sql<number>`coalesce(${telemetry.fields}->>'j1939FuelLevelPct', ${telemetry.fields}->>'obdFuelLevelPct')::float`;
const HAS_FUEL_LEVEL = sql`(${telemetry.fields} ? 'j1939FuelLevelPct' or ${telemetry.fields} ? 'obdFuelLevelPct')`;
const TOTAL_FUEL = sql<number | null>`(${telemetry.fields}->>'j1939TotalFuelL')::float`;

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const litresOf = (machine: Pick<Machine, "fuelTankLitres">, pct: number) => (machine.fuelTankLitres ? (pct / 100) * machine.fuelTankLitres : null);
/** Big enough to count: a share of the tank, and (with the tank size) a number of litres. */
const significant = (machine: Pick<Machine, "fuelTankLitres">, pct: number, minPct: number, minLitres: number) => {
  const litres = litresOf(machine, pct);
  return pct >= minPct && (litres === null || litres >= minLitres);
};
const tankNote = (machine: Pick<Machine, "fuelTankLitres">, pct: number) => {
  const litres = litresOf(machine, pct);
  return litres === null ? "" : ` (about ${Math.round(litres)} L of the ${Math.round(machine.fuelTankLitres!)} L tank)`;
};

async function logRefuel(db: Db, machine: Machine, session: EngineSession, when: "parked" | "running", fromPct: number, toPct: number, at: Date, burnedL = 0) {
  const added = litresOf(machine, toPct - fromPct);
  const litres = added === null ? null : added + burnedL;
  await db.insert(fuelEvents).values({
    organizationId: machine.organizationId,
    machineId: machine.id,
    engineSessionId: session.id,
    kind: "refuel",
    when,
    at,
    fromPct,
    toPct,
    litres,
  });
  await recordEvent(db, {
    organizationId: machine.organizationId,
    machineId: machine.id,
    type: "refuel",
    engineSessionId: null,
    detail: `Refuelled${when === "running" ? " (engine running)" : ""}: ${Math.round(fromPct)}% → ${Math.round(toPct)}%${litres !== null ? `, about ${Math.round(litres)} L` : ""}.`,
    occurredAt: at,
  });
}

/**
 * Check 1: at an engine start, once the level has settled, compare it with the level at the last stop.
 * Every machine with fuel level data is checked, whatever its service level (it's a theft alert).
 * Returns new alerts.
 */
export async function checkFuelTheft(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const [session] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt), isNull(engineSessions.fuelCheckedAt)));
  if (!session) return [];
  const runningMs = now.getTime() - session.startedAt.getTime();
  if (runningMs < FUEL_RULES.settleMinutes * 60_000) return [];

  const after = await db
    .select({ level: FUEL_LEVEL, total: TOTAL_FUEL })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, machineId), eq(telemetry.engineOn, true), gte(telemetry.receivedAt, session.startedAt), HAS_FUEL_LEVEL))
    .orderBy(telemetry.receivedAt, telemetry.id)
    .limit(FUEL_RULES.readings);
  if (after.length < Math.min(3, FUEL_RULES.readings)) {
    if (runningMs > FUEL_RULES.giveUpMinutes * 60_000) {
      await db.update(engineSessions).set({ fuelCheckedAt: now }).where(eq(engineSessions.id, session.id)); // no fuel data
    }
    return [];
  }
  const startPct = median(after.map((r) => Number(r.level)));
  const totals = after.map((r) => r.total).filter((t): t is number => t !== null);
  // This is also the first reference point for the checks while running.
  await db
    .update(engineSessions)
    .set({
      fuelStartPct: startPct,
      fuelCheckedAt: now,
      fuelAnchorPct: startPct,
      fuelAnchorTotalL: totals.length ? Number(totals.at(-1)) : null,
      fuelAnchorAt: now,
      fuelRunCheckedAt: now,
    })
    .where(eq(engineSessions.id, session.id));

  const before = await db
    .select({ level: FUEL_LEVEL, at: telemetry.receivedAt })
    .from(telemetry)
    .where(
      and(
        eq(telemetry.machineId, machineId),
        eq(telemetry.engineOn, true),
        lt(telemetry.receivedAt, session.startedAt),
        gte(telemetry.receivedAt, new Date(session.startedAt.getTime() - FUEL_RULES.lookbackDays * 86_400_000)),
        HAS_FUEL_LEVEL,
      ),
    )
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(FUEL_RULES.readings);
  if (before.length === 0) return [];
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) return [];
  const stopPct = median(before.map((r) => Number(r.level)));

  if (significant(machine, startPct - stopPct, FUEL_RULES.minRefuelPct, FUEL_RULES.minRefuelLitres)) {
    await logRefuel(db, machine, session, "parked", stopPct, startPct, session.startedAt);
    return [];
  }
  const dropPct = stopPct - startPct;
  if (!significant(machine, dropPct, FUEL_RULES.minDropPct, FUEL_RULES.minDropLitres)) return [];

  const tz = await orgTimeZone(db, machine.organizationId);
  const stoppedAt = before[0].at;
  const parked = (session.startedAt.getTime() - stoppedAt.getTime()) / 3_600_000;
  const raised = await db
    .insert(alerts)
    .values({
      organizationId: machine.organizationId,
      machineId,
      type: "fuel-theft",
      engineSessionId: session.id,
      createdAt: now,
      title: `Possible fuel theft: ${machineLabel(machine)}`,
      detail:
        `The fuel level dropped from ${Math.round(stopPct)}% to ${Math.round(startPct)}%${tankNote(machine, dropPct)}` +
        ` while the engine was off: stopped ${clockTime(stoppedAt, tz, now.getTime())}, started again ${clockTime(session.startedAt, tz, now.getTime())}` +
        ` (${formatHours(parked)} later). Check the tank and fuel cap.`,
    })
    .onConflictDoNothing()
    .returning();
  if (raised.length) {
    await db.insert(fuelEvents).values({
      organizationId: machine.organizationId,
      machineId,
      engineSessionId: session.id,
      kind: "theft",
      when: "parked",
      at: session.startedAt,
      fromPct: stopPct,
      toPct: startPct,
      litres: litresOf(machine, dropPct),
      alertId: raised[0].id,
    });
  }
  return raised;
}

/**
 * Check 2, while the engine runs (every few minutes): compare the tank level and the engine's fuel meter
 * with the reference point. A rise is a refuel. On J1939 machines with a tank size, a drop bigger than the
 * fuel the engine burned is fuel lost while running ("Possible fuel theft (while running)", once per
 * engine-on period). The reference point is renewed after each finding and at least hourly. Returns new alerts.
 */
export async function checkFuelWhileRunning(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const [session] = await db
    .select()
    .from(engineSessions)
    .where(and(eq(engineSessions.machineId, machineId), isNull(engineSessions.endedAt)));
  if (!session || session.fuelAnchorPct === null || !session.fuelAnchorAt) return [];
  if (session.fuelRunCheckedAt && now.getTime() - session.fuelRunCheckedAt.getTime() < FUEL_RULES.runCheckMinutes * 60_000) return [];

  const latest = await db
    .select({ level: FUEL_LEVEL, total: TOTAL_FUEL })
    .from(telemetry)
    .where(and(eq(telemetry.machineId, machineId), eq(telemetry.engineOn, true), gte(telemetry.receivedAt, session.fuelAnchorAt), HAS_FUEL_LEVEL))
    .orderBy(desc(telemetry.receivedAt), desc(telemetry.id))
    .limit(FUEL_RULES.readings);
  const setAnchor = (values: Partial<typeof engineSessions.$inferInsert>) =>
    db.update(engineSessions).set({ fuelRunCheckedAt: now, ...values }).where(eq(engineSessions.id, session.id));
  if (latest.length < Math.min(3, FUEL_RULES.readings)) {
    await setAnchor({});
    return [];
  }
  const [machine] = await db.select().from(machines).where(eq(machines.id, machineId));
  if (!machine) return [];
  const nowPct = median(latest.map((r) => Number(r.level)));
  const nowTotal = latest[0].total === null ? null : Number(latest[0].total);
  const burnedL = nowTotal !== null && session.fuelAnchorTotalL !== null ? Math.max(0, nowTotal - session.fuelAnchorTotalL) : null;
  const renew = { fuelAnchorPct: nowPct, fuelAnchorTotalL: nowTotal, fuelAnchorAt: now };
  const burnedPct = burnedL !== null && machine.fuelTankLitres ? (burnedL / machine.fuelTankLitres) * 100 : 0;

  // Refuel: the level is higher than the reference point plus what was burned since.
  if (significant(machine, nowPct - session.fuelAnchorPct + burnedPct, FUEL_RULES.minRefuelPct, FUEL_RULES.minRefuelLitres) && nowPct > session.fuelAnchorPct) {
    await logRefuel(db, machine, session, "running", session.fuelAnchorPct, nowPct, now, burnedL ?? 0);
    await setAnchor(renew);
    return [];
  }

  // Fuel lost while running: needs the engine's fuel meter and the tank size to compare like with like.
  if (burnedL !== null && machine.fuelTankLitres) {
    const droppedL = ((session.fuelAnchorPct - nowPct) / 100) * machine.fuelTankLitres;
    const unexplainedL = droppedL - burnedL;
    const unexplainedPct = (unexplainedL / machine.fuelTankLitres) * 100;
    if (significant(machine, unexplainedPct, FUEL_RULES.minDropPct, FUEL_RULES.minDropLitres)) {
      const tz = await orgTimeZone(db, machine.organizationId);
      const raised = await db
        .insert(alerts)
        .values({
          organizationId: machine.organizationId,
          machineId,
          type: "fuel-loss",
          engineSessionId: session.id,
          createdAt: now,
          title: `Possible fuel theft (while running): ${machineLabel(machine)}`,
          detail:
            `Since ${clockTime(session.fuelAnchorAt, tz, now.getTime())} the tank dropped from ${Math.round(session.fuelAnchorPct)}% to ${Math.round(nowPct)}%` +
            ` (about ${Math.round(droppedL)} L), but the engine only burned ${Math.round(burnedL)} L: about ${Math.round(unexplainedL)} L is unaccounted for.` +
            ` Check for siphoning or a leak.`,
        })
        .onConflictDoNothing()
        .returning();
      if (raised.length) {
        await db.insert(fuelEvents).values({
          organizationId: machine.organizationId,
          machineId,
          engineSessionId: session.id,
          kind: "loss",
          when: "running",
          at: now,
          fromPct: session.fuelAnchorPct,
          toPct: nowPct,
          litres: unexplainedL,
          alertId: raised[0].id,
        });
      }
      await setAnchor(renew);
      return raised;
    }
  }

  // Nothing found: keep the reference point for up to an hour (so a slow loss still adds up), then renew it.
  const anchorAge = now.getTime() - session.fuelAnchorAt.getTime();
  await setAnchor(anchorAge > FUEL_RULES.anchorMaxMinutes * 60_000 ? renew : {});
  return [];
}
