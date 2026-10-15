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

export type Device = typeof devices.$inferSelect;
export type TelemetryRow = typeof telemetry.$inferSelect;
export type DeviceEvent = typeof deviceEvents.$inferSelect;
export type EngineSession = typeof engineSessions.$inferSelect;
export type Tier = (typeof tierEnum.enumValues)[number];
