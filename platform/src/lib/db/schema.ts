import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  bigserial,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Subscription tier for a machine. Mirrors the Veristart product levels:
 *  - gps:     GPS & Telematics (visibility only)
 *  - monitor: Safety & Access Monitoring (operator ID, alerts, no relay)
 *  - control: Safety & Access Control (starter relay) — future, not built yet
 */
export const tierEnum = pgEnum("tier", ["gps", "monitor", "control"]);

/** One row per physical device. The device ID is the 8-character ID the Freematics firmware generates. */
export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  name: text("name"),
  tier: tierEnum("tier").notNull().default("gps"),
  vin: text("vin"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastFixAt: timestamp("last_fix_at", { withTimezone: true }),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastSpeedKph: real("last_speed_kph"),
  lastBatteryV: real("last_battery_v"),
  lastRssi: integer("last_rssi"),
  /** Latest engine state (null = unknown). See src/lib/telemetry/engine.ts. */
  engineOn: boolean("engine_on"),
  engineChangedAt: timestamp("engine_changed_at", { withTimezone: true }),
  /**
   * Safety & Access Monitoring machines are armed unless disarmed (e.g. during a service visit).
   * disarmedUntil set → re-arms automatically at that time; null → disarmed until someone re-arms.
   */
  disarmed: boolean("disarmed").notNull().default(false),
  disarmedUntil: timestamp("disarmed_until", { withTimezone: true }),
});

/** One row per data sample sent by a device. */
export const telemetry = pgTable(
  "telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** Device uptime in ms when the sample was taken (not a wall-clock time). */
    deviceMs: bigint("device_ms", { mode: "number" }),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    altitudeM: real("altitude_m"),
    speedKph: real("speed_kph"),
    heading: integer("heading"),
    satellites: integer("satellites"),
    batteryV: real("battery_v"),
    rssi: integer("rssi"),
    deviceTempC: real("device_temp_c"),
    /** Engine running at this sample (null = couldn't tell). */
    engineOn: boolean("engine_on"),
    /** Every field in the sample, keyed by name, including OBD and motion data. */
    fields: jsonb("fields").$type<Record<string, number | number[]>>().notNull(),
  },
  (t) => [index("telemetry_device_time_idx").on(t.deviceId, t.receivedAt)],
);

/** Connection events: login, logout, ping, etc. */
export const deviceEvents = pgTable(
  "device_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    rssi: integer("rssi"),
    detail: text("detail"),
  },
  (t) => [index("device_events_device_time_idx").on(t.deviceId, t.at)],
);

/**
 * One row per engine-on period. An open session has no endedAt.
 * At most one open session per device (enforced by the partial unique index).
 */
export const engineSessions = pgTable(
  "engine_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Last report while running; used to close sessions when a device goes silent. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Which signal detected it: rpm, voltage or vibration. */
    source: text("source"),
  },
  (t) => [
    index("engine_sessions_device_start_idx").on(t.deviceId, t.startedAt),
    uniqueIndex("engine_sessions_one_open_idx").on(t.deviceId).where(sql`${t.endedAt} is null`),
  ],
);

/**
 * People who operate machines. They identify themselves on the check-in page with a PIN.
 * PINs are short, so they're a convenience, not strong security: the hash only keeps them out of
 * plain sight in the database, and the check-in page rate-limits wrong guesses.
 */
export const operators = pgTable("operators", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  /** See hashPin() in src/lib/operators.ts. Unique, because the PIN alone identifies the operator. */
  pinHash: text("pin_hash").notNull().unique(),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Which operators may run which machine. A machine with no rows here accepts any active operator.
 */
export const machineOperators = pgTable(
  "machine_operators",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" })
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.deviceId, t.operatorId] })],
);

export type ChecklistAnswer = { id: string; question: string; ok: boolean };

/**
 * One row per operator check-in (QR code on the machine → PIN → pre-start checklist).
 * Open check-ins have no endedAt. At most one open check-in per machine.
 */
export const checkins = pgTable(
  "checkins",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" })
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** checkout, replaced (another operator checked in), moved (operator checked in elsewhere). */
    endReason: text("end_reason"),
    /** False if the operator isn't on this machine's list of allowed operators. */
    authorized: boolean("authorized").notNull(),
    /** True when every checklist item was answered OK. */
    checklistOk: boolean("checklist_ok").notNull(),
    answers: jsonb("answers").$type<ChecklistAnswer[]>().notNull(),
    notes: text("notes"),
    /** Phone position at check-in (if the operator shared it) and its accuracy radius in metres. */
    phoneLat: doublePrecision("phone_lat"),
    phoneLng: doublePrecision("phone_lng"),
    phoneAccuracyM: real("phone_accuracy_m"),
    /** Distance between the phone and the machine's last GPS position, in metres. */
    distanceM: real("distance_m"),
    /** near, far, no-phone-location or no-machine-location. Null for check-ins made before this check existed. */
    locationCheck: text("location_check"),
  },
  (t) => [
    index("checkins_device_start_idx").on(t.deviceId, t.startedAt),
    index("checkins_operator_start_idx").on(t.operatorId, t.startedAt),
    uniqueIndex("checkins_one_open_idx").on(t.deviceId).where(sql`${t.endedAt} is null`),
  ],
);

/** Wrong PINs entered on a machine's check-in page, for rate limiting. */
export const pinFailures = pgTable(
  "pin_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pin_failures_device_time_idx").on(t.deviceId, t.at)],
);

/**
 * Alerts for the fleet manager (Tier 2). Each is raised once: per engine-on period for unauthorized use,
 * per check-in for check-in problems (enforced by the unique indexes).
 */
export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** unauthorized-use, checklist-failed, not-approved, not-at-machine */
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title").notNull(),
    detail: text("detail"),
    engineSessionId: bigint("engine_session_id", { mode: "number" }).references(() => engineSessions.id, {
      onDelete: "set null",
    }),
    checkinId: bigint("checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ackNote: text("ack_note"),
    /** sent, failed or not-configured (no email settings yet). Null while sending. */
    emailStatus: text("email_status"),
    emailError: text("email_error"),
  },
  (t) => [
    index("alerts_created_idx").on(t.createdAt),
    index("alerts_device_created_idx").on(t.deviceId, t.createdAt),
    uniqueIndex("alerts_one_per_engine_session_idx").on(t.type, t.engineSessionId),
    uniqueIndex("alerts_one_per_checkin_idx").on(t.type, t.checkinId),
  ],
);

export type Device = typeof devices.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type TelemetryRow = typeof telemetry.$inferSelect;
export type DeviceEvent = typeof deviceEvents.$inferSelect;
export type EngineSession = typeof engineSessions.$inferSelect;
export type Operator = typeof operators.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
export type Tier = (typeof tierEnum.enumValues)[number];
