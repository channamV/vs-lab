import { and, asc, eq, gt, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/lib/db";
import {
  alerts,
  checkins,
  engineSessions,
  machines,
  operators,
  organizations,
  safetyEvents,
  worksites,
  worksiteVisits,
  type Alert,
  type Machine,
  type Organization,
} from "@/lib/db/schema";
import { clockTime, formatHours, machineLabel } from "@/lib/format";
import { recordEvent } from "@/lib/notifications";
import { appTimeZone, effectiveEnd, localDateKey, startOfLocalDay } from "@/lib/telemetry/engine";
import { currentOperatorId } from "@/lib/worksites";
import type { SafetyKind } from "@/lib/safety-kinds";

export { SAFETY_KINDS, SAFETY_UNITS, type SafetyKind } from "@/lib/safety-kinds";

/**
 * Safety rules (docs/safety.md). Everything here works with the stock Telelogger firmware:
 *  - Speeding: GPS speed above the fleet limit, or a lower worksite limit while the machine is in that site.
 *    A spell is only counted once it lasts SAFETY_RULES.speedingGraceSeconds (brief GPS spikes are ignored).
 *  - Restricted areas: worksites of type "restricted" (exclusion zones). Entering one raises an alert at once.
 *  - Excessive idling: engine running below SAFETY_RULES.idleRpm and not moving for longer than the company's
 *    limit. Needs engine RPM (OBD or J1939); voltage-only machines can't tell idling from working.
 *  - Operator fatigue: hours operated in a day, and hours without a break, from check-ins and engine time.
 * Each occurrence is a row in safety_events (the safety log, Reports → Safety) and a notification event.
 */
export const SAFETY_RULES = {
  /** GPS speed must be this far over the limit to count (GPS speed wobbles by a km/h or two). */
  speedMarginKph: 2,
  /** A speeding spell only counts once it has lasted this long. */
  speedingGraceSeconds: 10,
  /** Fixes from fewer satellites than this are too rough for speed. */
  minSatellites: 4,
  /** Engine running below this RPM, and not moving, is idling (diesel idle is typically 650–900 rpm). */
  idleRpm: 1000,
  idleSpeedKph: 2,
  /** A device silent this long ends a speeding spell or idle stretch at its previous report. */
  gapMinutes: 5,
  /** Operator time: engine-on periods closer together than this count as one continuous stretch. */
  breakMinutes: 15,
  /** Limits Settings accepts. */
  limits: {
    speedKph: [5, 200],
    idleMinutes: [5, 240],
    dailyHours: [4, 24],
    continuousHours: [1, 12],
  },
};

export class SafetyError extends Error {}

export type SafetySettings = Pick<Organization, "speedLimitKph" | "idleAlertMinutes" | "fatigueDailyHours" | "fatigueContinuousHours">;

/** Checks and saves the company's safety rules (owner-only Settings). Blank = off. */
export async function updateSafetySettings(db: Db, organizationId: number, input: Record<keyof SafetySettings, string>) {
  const L = SAFETY_RULES.limits;
  const read = (value: string, [min, max]: number[], what: string, integer = false) => {
    const v = value.trim();
    if (!v) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
      throw new SafetyError(`${what} must be between ${min} and ${max}${integer ? " (whole minutes)" : ""}, or blank for off.`);
    }
    return n;
  };
  const values = {
    speedLimitKph: read(input.speedLimitKph, L.speedKph, "The speed limit"),
    idleAlertMinutes: read(input.idleAlertMinutes, L.idleMinutes, "The idling limit", true),
    fatigueDailyHours: read(input.fatigueDailyHours, L.dailyHours, "Hours in a day"),
    fatigueContinuousHours: read(input.fatigueContinuousHours, L.continuousHours, "Hours without a break"),
  };
  await db.update(organizations).set(values).where(eq(organizations.id, organizationId));
  return values;
}

/** A worksite speed limit from a form: blank = none (the fleet limit applies). */
export function parseSiteSpeedLimit(value: string): number | null {
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  const [min, max] = SAFETY_RULES.limits.speedKph;
  if (!Number.isFinite(n) || n < min || n > max) throw new SafetyError(`The site speed limit must be between ${min} and ${max} km/h, or blank.`);
  return n;
}

// ---------- Speeding and idling (from each device report) ----------

export type MotionSample = { speedKph: number | null; satellites: number | null; rpm: number | null; engineOn: boolean | null };

/** The speed limit that applies to the machine now: the lowest limit of the sites it's in, else the fleet's. */
export async function speedLimitFor(db: Db, machine: Pick<Machine, "id">, org: Pick<Organization, "speedLimitKph">) {
  const [site] = await db
    .select({ id: worksites.id, name: worksites.name, limit: worksites.speedLimitKph })
    .from(worksiteVisits)
    .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
    .where(and(eq(worksiteVisits.machineId, machine.id), isNull(worksiteVisits.leftAt), isNotNull(worksites.speedLimitKph)))
    .orderBy(asc(worksites.speedLimitKph))
    .limit(1);
  if (site) return { limit: site.limit!, worksiteId: site.id, where: `the ${site.name} site limit` };
  if (org.speedLimitKph !== null) return { limit: org.speedLimitKph, worksiteId: null, where: "the fleet limit" };
  return null;
}

const kph = (v: number) => `${Math.round(v)} km/h`;

/**
 * Speeding and idling for one device report on a paired machine (called from ingest). `previousReportAt`
 * is the device's last contact before this one: after a long gap, open spells end at that time.
 * Returns the number of notification events recorded.
 */
export async function checkSpeedAndIdle(db: Db, machineId: number, samples: MotionSample[], now: Date, previousReportAt: Date | null) {
  const [row] = await db
    .select({ machine: machines, org: organizations })
    .from(machines)
    .innerJoin(organizations, eq(organizations.id, machines.organizationId))
    .where(eq(machines.id, machineId));
  if (!row) return 0;
  let { machine } = row;
  const { org } = row;

  // A long silence: whatever was going on ended at the previous report.
  if (previousReportAt && now.getTime() - previousReportAt.getTime() > SAFETY_RULES.gapMinutes * 60_000) {
    await endSpeeding(db, machine, previousReportAt);
    await endIdle(db, machine, previousReportAt);
    machine = { ...machine, speedingEventId: null, idleSince: null, idleEventId: null };
  }
  let events = 0;
  events += await checkSpeeding(db, machine, org, samples, now);
  events += await checkIdle(db, machine, org, samples, now);
  return events;
}

async function checkSpeeding(db: Db, machine: Machine, org: Organization, samples: MotionSample[], now: Date) {
  const speeds = samples
    .filter((s) => s.speedKph !== null && (s.satellites === null || s.satellites >= SAFETY_RULES.minSatellites))
    .map((s) => s.speedKph!);
  if (speeds.length === 0) return 0;
  const top = Math.max(...speeds);
  const rule = await speedLimitFor(db, machine, org);
  const over = rule !== null && top > rule.limit + SAFETY_RULES.speedMarginKph;
  if (!over) {
    // Back under the limit (or no limit any more) — but only the last reading decides it's over.
    if (machine.speedingEventId && (rule === null || speeds.at(-1)! <= rule.limit + SAFETY_RULES.speedMarginKph)) await endSpeeding(db, machine, now);
    return 0;
  }

  const eventId = machine.speedingEventId;
  if (!eventId) {
    const [created] = await db
      .insert(safetyEvents)
      .values({
        organizationId: machine.organizationId,
        machineId: machine.id,
        operatorId: await currentOperatorId(db, machine.id),
        worksiteId: rule.worksiteId,
        kind: "speeding",
        startedAt: now,
        peak: top,
        limitValue: rule.limit,
        detail: `Over ${rule.where} of ${kph(rule.limit)}.`,
      })
      .returning();
    await db.update(machines).set({ speedingEventId: created.id }).where(eq(machines.id, machine.id));
    return 0;
  }
  const [spell] = await db
    .update(safetyEvents)
    .set({ peak: sql`greatest(${safetyEvents.peak}, ${top})` })
    .where(eq(safetyEvents.id, eventId))
    .returning();
  if (!spell) {
    await db.update(machines).set({ speedingEventId: null }).where(eq(machines.id, machine.id));
    return 0;
  }
  if (spell.notifiedAt || now.getTime() - spell.startedAt.getTime() < SAFETY_RULES.speedingGraceSeconds * 1000) return 0;
  await db.update(safetyEvents).set({ notifiedAt: now }).where(eq(safetyEvents.id, spell.id));
  const id = await recordEvent(db, {
    organizationId: machine.organizationId,
    machineId: machine.id,
    type: "speeding",
    operatorId: spell.operatorId,
    worksiteId: spell.worksiteId,
    detail: `${kph(spell.peak ?? top)} — over ${rule.where} of ${kph(rule.limit)}.`,
    occurredAt: spell.startedAt,
  });
  return id ? 1 : 0;
}

/** Ends the open speeding spell. One that never lasted the grace period was a GPS spike: it's dropped. */
async function endSpeeding(db: Db, machine: Pick<Machine, "id" | "speedingEventId">, at: Date) {
  if (!machine.speedingEventId) return;
  const [spell] = await db.select().from(safetyEvents).where(eq(safetyEvents.id, machine.speedingEventId));
  if (spell && !spell.notifiedAt) await db.delete(safetyEvents).where(eq(safetyEvents.id, spell.id));
  else if (spell) await db.update(safetyEvents).set({ endedAt: at < spell.startedAt ? spell.startedAt : at }).where(eq(safetyEvents.id, spell.id));
  await db.update(machines).set({ speedingEventId: null }).where(eq(machines.id, machine.id));
}

/** idle = engine running at low RPM and not moving; working = higher RPM or moving; null = can't tell. */
export function idleState(s: MotionSample): "idle" | "working" | "off" | null {
  if (s.rpm === null) return s.engineOn === false ? "off" : null;
  if (s.rpm < 300) return "off";
  if (s.rpm >= SAFETY_RULES.idleRpm || (s.speedKph !== null && s.speedKph >= SAFETY_RULES.idleSpeedKph)) return "working";
  return "idle";
}

async function checkIdle(db: Db, machine: Machine, org: Organization, samples: MotionSample[], now: Date) {
  const state = samples.map(idleState).findLast((s) => s !== null);
  if (!state) return 0;
  if (state !== "idle" || !org.idleAlertMinutes) {
    await endIdle(db, machine, now);
    return 0;
  }
  if (!machine.idleSince) {
    await db.update(machines).set({ idleSince: now }).where(eq(machines.id, machine.id));
    return 0;
  }
  const minutes = (now.getTime() - machine.idleSince.getTime()) / 60_000;
  if (machine.idleEventId) {
    await db.update(safetyEvents).set({ peak: minutes }).where(eq(safetyEvents.id, machine.idleEventId));
    return 0;
  }
  if (minutes < org.idleAlertMinutes) return 0;
  const operatorId = await currentOperatorId(db, machine.id);
  const [created] = await db
    .insert(safetyEvents)
    .values({
      organizationId: machine.organizationId,
      machineId: machine.id,
      operatorId,
      kind: "excessive_idle",
      startedAt: machine.idleSince,
      peak: minutes,
      limitValue: org.idleAlertMinutes,
      notifiedAt: now,
    })
    .returning();
  await db.update(machines).set({ idleEventId: created.id }).where(eq(machines.id, machine.id));
  const id = await recordEvent(db, {
    organizationId: machine.organizationId,
    machineId: machine.id,
    type: "excessive_idle",
    operatorId,
    detail: `Idling since ${clockTime(machine.idleSince, appTimeZone(), now.getTime())} (over ${org.idleAlertMinutes} min).`,
    occurredAt: now,
  });
  return id ? 1 : 0;
}

async function endIdle(db: Db, machine: Pick<Machine, "id" | "idleSince" | "idleEventId">, at: Date) {
  if (!machine.idleSince && !machine.idleEventId) return;
  if (machine.idleEventId && machine.idleSince) {
    const minutes = Math.max(0, (at.getTime() - machine.idleSince.getTime()) / 60_000);
    await db.update(safetyEvents).set({ endedAt: at, peak: minutes }).where(eq(safetyEvents.id, machine.idleEventId));
  }
  await db.update(machines).set({ idleSince: null, idleEventId: null }).where(eq(machines.id, machine.id));
}

// ---------- Restricted areas (after each device report) ----------

/**
 * Raises a "Restricted area" alert for each restricted site the machine is in and hasn't been alerted
 * for this visit (one alert per entry, whatever the machine's tier). Returns the new alerts.
 */
export async function checkRestrictedAreas(db: Db, machineId: number, now = new Date()): Promise<Alert[]> {
  const inside = await db
    .select({ visit: worksiteVisits, site: worksites, machine: machines })
    .from(worksiteVisits)
    .innerJoin(worksites, eq(worksites.id, worksiteVisits.worksiteId))
    .innerJoin(machines, eq(machines.id, worksiteVisits.machineId))
    .where(and(eq(worksiteVisits.machineId, machineId), isNull(worksiteVisits.leftAt), eq(worksites.type, "restricted")));
  const raised: Alert[] = [];
  for (const { visit, site, machine } of inside) {
    const [alert] = await db
      .insert(alerts)
      .values({
        organizationId: machine.organizationId,
        machineId,
        type: "restricted-area",
        worksiteVisitId: visit.id,
        createdAt: now,
        title: `Restricted area: ${machineLabel(machine)} entered ${site.name}`,
        detail:
          `${machineLabel(machine)} entered the restricted area "${site.name}" at ${clockTime(visit.enteredAt, appTimeZone(), now.getTime())}` +
          `${site.notes ? ` (${site.notes})` : ""}. Check who is operating it and why.`,
      })
      .onConflictDoNothing()
      .returning();
    if (!alert) continue;
    raised.push(alert);
    await db
      .insert(safetyEvents)
      .values({
        organizationId: machine.organizationId,
        machineId,
        operatorId: await currentOperatorId(db, machineId),
        worksiteId: site.id,
        kind: "restricted_area",
        startedAt: visit.enteredAt,
        notifiedAt: now,
        detail: `Entered "${site.name}".`,
        dedupeKey: `restricted:${visit.id}`,
      })
      .onConflictDoNothing();
  }
  // Note when the machine left restricted areas it was logged in.
  await db.execute(sql`
    update ${safetyEvents} se set ended_at = v.left_at
    from ${worksiteVisits} v
    where se.kind = 'restricted_area' and se.ended_at is null and se.machine_id = ${machineId}
      and se.dedupe_key = 'restricted:' || v.id and v.left_at is not null`);
  return raised;
}

// ---------- Operator fatigue (from the watchdog, every 5 minutes) ----------

type Span = { start: number; end: number; machineId: number };

/** Joins engine-on periods closer together than the break allowance into continuous stretches. */
export function continuousBlocks(spans: Span[], breakMinutes = SAFETY_RULES.breakMinutes): Span[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const blocks: Span[] = [];
  for (const s of sorted) {
    const last = blocks.at(-1);
    if (last && s.start - last.end < breakMinutes * 60_000) {
      if (s.end > last.end) Object.assign(last, { end: s.end, machineId: s.machineId });
    } else blocks.push({ ...s });
  }
  return blocks;
}

/** Hours of the spans that fall between from and to. */
export function hoursBetween(spans: Span[], from: number, to: number) {
  return continuousBlocks(spans, 0).reduce((sum, s) => sum + Math.max(0, Math.min(s.end, to) - Math.max(s.start, from)), 0) / 3_600_000;
}

/**
 * Operator fatigue: for each operator who has worked recently, the engine time while they were checked in.
 * Records one event per operator per day over the daily limit, and one per stretch without a
 * SAFETY_RULES.breakMinutes break that went over the continuous limit. Returns the number of events.
 */
export async function checkFatigue(db: Db, now = new Date()): Promise<number> {
  const orgs = await db
    .select()
    .from(organizations)
    .where(or(isNotNull(organizations.fatigueDailyHours), isNotNull(organizations.fatigueContinuousHours)));
  if (orgs.length === 0) return 0;
  const tz = appTimeZone();
  const nowMs = now.getTime();
  const since = new Date(Math.min(startOfLocalDay(nowMs, tz), nowMs - 24 * 3_600_000));
  const recent = await db
    .select()
    .from(checkins)
    .where(
      and(
        inArray(checkins.organizationId, orgs.map((o) => o.id)),
        or(isNull(checkins.endedAt), gt(checkins.endedAt, since)),
        lt(checkins.startedAt, now),
      ),
    );
  if (recent.length === 0) return 0;
  const sessions = await db
    .select()
    .from(engineSessions)
    .where(
      and(
        inArray(engineSessions.machineId, [...new Set(recent.map((c) => c.machineId))]),
        or(isNull(engineSessions.endedAt), gt(engineSessions.endedAt, since)),
      ),
    );

  // Operator → engine time while checked in.
  const spansByOperator = new Map<number, Span[]>();
  for (const c of recent) {
    const cStart = c.startedAt.getTime();
    const cEnd = c.endedAt?.getTime() ?? nowMs;
    for (const s of sessions) {
      if (s.machineId !== c.machineId) continue;
      const start = Math.max(cStart, s.startedAt.getTime(), since.getTime());
      const end = Math.min(cEnd, effectiveEnd(s, nowMs));
      if (end > start) spansByOperator.set(c.operatorId, [...(spansByOperator.get(c.operatorId) ?? []), { start, end, machineId: c.machineId }]);
    }
  }
  if (spansByOperator.size === 0) return 0;
  const ops = await db
    .select({ id: operators.id, organizationId: operators.organizationId, name: operators.name })
    .from(operators)
    .where(inArray(operators.id, [...spansByOperator.keys()]));

  let events = 0;
  const today = startOfLocalDay(nowMs, tz);
  for (const op of ops) {
    const org = orgs.find((o) => o.id === op.organizationId);
    const spans = spansByOperator.get(op.id)!;
    if (!org) continue;
    const latest = spans.reduce((a, b) => (b.end > a.end ? b : a));
    const log = async (kind: SafetyKind, dedupeKey: string, startedAt: number, hours: number, limit: number, detail: string) => {
      const [created] = await db
        .insert(safetyEvents)
        .values({
          organizationId: op.organizationId,
          machineId: latest.machineId,
          operatorId: op.id,
          kind,
          startedAt: new Date(startedAt),
          peak: hours,
          limitValue: limit,
          notifiedAt: now,
          detail,
          dedupeKey,
        })
        .onConflictDoNothing()
        .returning();
      if (!created) return;
      const id = await recordEvent(db, {
        organizationId: op.organizationId,
        machineId: latest.machineId,
        type: "operator_fatigue",
        operatorId: op.id,
        detail,
        occurredAt: now,
      });
      if (id) events++;
    };

    if (org.fatigueDailyHours) {
      const hours = hoursBetween(spans, today, nowMs);
      if (hours > org.fatigueDailyHours) {
        await log(
          "fatigue_daily",
          `fatigue_daily:${op.id}:${localDateKey(nowMs, tz)}`,
          today,
          hours,
          org.fatigueDailyHours,
          `${op.name} has operated machines for ${formatHours(hours)} today (limit ${formatHours(org.fatigueDailyHours)}).`,
        );
      }
    }
    if (org.fatigueContinuousHours) {
      for (const block of continuousBlocks(spans)) {
        const hours = (block.end - block.start) / 3_600_000;
        if (hours <= org.fatigueContinuousHours || block.end < nowMs - 3 * 3_600_000) continue;
        await log(
          "fatigue_continuous",
          `fatigue_continuous:${op.id}:${block.start}`,
          block.start,
          hours,
          org.fatigueContinuousHours,
          `${op.name} has operated for ${formatHours(hours)} without a ${SAFETY_RULES.breakMinutes}-minute break, since ${clockTime(new Date(block.start), tz, nowMs)} (limit ${formatHours(org.fatigueContinuousHours)}).`,
        );
      }
    }
  }
  return events;
}
