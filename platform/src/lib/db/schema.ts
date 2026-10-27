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

/**
 * A customer account (the tenant). Everything a customer sees belongs to exactly one organization:
 * machines, operators, check-ins, alerts and users. Nothing is shared between organizations.
 */
export const organizations = pgTable("organizations", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Who operators contact about their data (shown on the check-in page), e.g. "privacy@abc.com". */
  privacyContact: text("privacy_contact"),
  /**
   * How long personal data is kept, in days (GDPR storage limitation). The nightly clean-up
   * (src/lib/privacy.ts) removes anything older. See RETENTION_LIMITS for the allowed ranges.
   */
  retainPhoneLocationDays: integer("retain_phone_location_days").notNull().default(90),
  retainPhotoDays: integer("retain_photo_days").notNull().default(365),
  retainTelemetryDays: integer("retain_telemetry_days").notNull().default(730),
  retainCheckinDays: integer("retain_checkin_days").notNull().default(1095),
  retainNotificationDays: integer("retain_notification_days").notNull().default(365),
  /**
   * Reports: the hours a machine is expected to work per working day, and which days are working days
   * (0 = Sunday … 6 = Saturday). Utilization = engine hours ÷ planned hours.
   */
  plannedHoursPerDay: real("planned_hours_per_day").notNull().default(8),
  /**
   * Safety rules (src/lib/safety.ts; Settings). Null = off. Fleet speed limit in km/h (worksites can set their
   * own); idle stretch that counts as excessive (minutes, machines that report RPM); operator fatigue: hours
   * operated in a day, and hours without a 15-minute break.
   */
  speedLimitKph: real("speed_limit_kph"),
  idleAlertMinutes: integer("idle_alert_minutes").default(30),
  fatigueDailyHours: real("fatigue_daily_hours").default(12),
  fatigueContinuousHours: real("fatigue_continuous_hours").default(5),
  /**
   * Posted speed limits (src/lib/posted-speed.ts): on-road vehicles are flagged when they drive more than this % over
   * the road's posted limit (OpenStreetMap). Null = off.
   */
  postedLimitTolerancePct: integer("posted_limit_tolerance_pct"),
  /**
   * Session hold (src/lib/relay.ts; docs/operator-app.md): on Safety & Access Control machines, an operator who checked in
   * with the app can restart within this many minutes of switching off (lunch) with their phone, on the same check-in.
   * Nobody else can start it meanwhile without checking in. Null = off (the normal break allowance applies).
   */
  sessionHoldMinutes: integer("session_hold_minutes").default(90),
  workingDays: integer("working_days").array().notNull().default(sql`'{1,2,3,4,5}'`),
  /** Fleet timezone (IANA): the default for new schedules (src/lib/schedules.ts). */
  timezone: text("timezone").notNull().default("America/Toronto"),
  /** When schedules overlap and disagree: least_restrictive (default) or most_restrictive. Veristart admins only. */
  scheduleConflictRule: text("schedule_conflict_rule").notNull().default("least_restrictive"),
  /** Scan to fill (src/lib/scan.ts): keep the scanned image with the record (default on). */
  retainScanImages: boolean("retain_scan_images").notNull().default(true),
});

/**
 * Privacy-relevant actions the customer can see: Veristart staff opening their organization, and
 * operator data exports and erasures. Kept for the life of the organization.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    /** Email of whoever did it. */
    actor: text("actor").notNull(),
    /** True for Veristart staff (platform admins). */
    staff: boolean("staff").notNull().default(false),
    /** staff-view, operator-export, operator-erase */
    action: text("action").notNull(),
    detail: text("detail"),
  },
  (t) => [index("audit_log_org_time_idx").on(t.organizationId, t.at)],
);

/**
 * owner: everything, including users. manager: machines, operators, operating modes, alerts. viewer: read-only.
 * Platform admins (Veristart staff) are listed in PLATFORM_ADMIN_EMAILS, not stored here.
 */
export const roleEnum = pgEnum("role", ["owner", "manager", "viewer"]);

/** People who sign in to the portal. One organization per user; they sign in with an emailed link. */
export const users = pgTable(
  "users",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Stored lower-case. */
    email: text("email").notNull(),
    name: text("name"),
    role: roleEnum("role").notNull().default("manager"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSignInAt: timestamp("last_sign_in_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

/**
 * Optional sub-groups of an organization (e.g. "Ontario", "Paving"). One level only. A company that
 * doesn't need them has none, and everything behaves as before.
 */
export const divisions = pgTable(
  "divisions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("divisions_org_name_idx").on(t.organizationId, t.name)],
);

/**
 * Which divisions a user is limited to. No rows = the whole organization. Owners always see the whole
 * organization, whatever is here.
 */
export const userDivisions = pgTable(
  "user_divisions",
  {
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    divisionId: bigint("division_id", { mode: "number" })
      .notNull()
      .references(() => divisions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.divisionId] })],
);

/** One-time sign-in links. Only a hash of the token is stored; the token itself is only in the email. */
export const loginTokens = pgTable(
  "login_tokens",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("login_tokens_hash_idx").on(t.tokenHash), index("login_tokens_email_idx").on(t.email, t.createdAt)],
);

/** Signed-in browsers. The cookie holds a random token; only its hash is stored. */
export const sessions = pgTable(
  "sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    tokenHash: text("token_hash").notNull(),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Platform admins only: the organization they're currently looking at (their own if null). */
    viewOrganizationId: bigint("view_organization_id", { mode: "number" }).references(() => organizations.id, {
      onDelete: "set null",
    }),
  },
  (t) => [uniqueIndex("sessions_token_idx").on(t.tokenHash)],
);

/**
 * A customer's piece of equipment (the backhoe), independent of the tracking device on it. The machine
 * owns its data: position history, engine hours, check-ins and alerts stay with it when its device is
 * replaced. Devices are paired with machines by Veristart staff (see deviceAssignments).
 */
export const machines = pgTable(
  "machines",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null = not in a division (seen only by people with access to the whole organization). */
    divisionId: bigint("division_id", { mode: "number" }).references(() => divisions.id, { onDelete: "restrict" }),
    /** Random code in the QR sticker URL (/checkin/<code>). Stays the same when the device is replaced. */
    code: text("code").notNull(),
    name: text("name").notNull(),
    /** The customer's unit / fleet number, e.g. "14". Unique within the organization. */
    unitNumber: text("unit_number"),
    /** e.g. Excavator, Backhoe, Loader */
    machineType: text("machine_type"),
    /** The category certifications are matched on (src/lib/training.ts), e.g. Excavator. */
    categoryId: bigint("category_id", { mode: "number" }),
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    /** Serial number or VIN. */
    serialNumber: text("serial_number"),
    /** Fuel tank size in litres (optional): turns fuel-level drops into litres for the fuel theft alert. */
    fuelTankLitres: real("fuel_tank_litres"),
    /** This machine's own top speed (km/h) for the Speeding notification; replaces the fleet limit. Null = fleet limit. */
    speedLimitKph: real("speed_limit_kph"),
    /** Drives on public roads: checked against posted speed limits (src/lib/posted-speed.ts). */
    onRoad: boolean("on_road").notNull().default(false),
    /** Posted speed limits: telemetry up to here has been checked. */
    roadCheckedUntil: timestamp("road_checked_until", { withTimezone: true }),
    tier: tierEnum("tier").notNull().default("gps"),
    /**
     * Operating mode (src/lib/modes.ts; docs/operating-modes.md): access_controlled, unlocked or locked. A timed
     * change (modeUntil) returns to modeRevertTo. The checklist safety lock (lockedOutAt) overrides it.
     */
    mode: text("mode").notNull().default("access_controlled"),
    modeUntil: timestamp("mode_until", { withTimezone: true }),
    modeRevertTo: text("mode_revert_to"),
    modeReason: text("mode_reason"),
    modeChangedAt: timestamp("mode_changed_at", { withTimezone: true }),
    modeChangedBy: text("mode_changed_by"),
    /** manager, schedule or timer: what made the latest change. */
    modeSource: text("mode_source"),
    /** Relay machines: the mode to fall back to after offlineAfterHours without contact (null = keep the mode). */
    offlineMode: text("offline_mode"),
    offlineAfterHours: integer("offline_after_hours").notNull().default(12),
    /** Relay machines: the mode the device last confirmed it's enforcing. */
    confirmedMode: text("confirmed_mode"),
    confirmedModeAt: timestamp("confirmed_mode_at", { withTimezone: true }),
    /** Locked: where the machine was when it was locked, and when "moved while locked" was alerted. */
    lockAnchorLat: doublePrecision("lock_anchor_lat"),
    lockAnchorLng: doublePrecision("lock_anchor_lng"),
    lockMovementAlertedAt: timestamp("lock_movement_alerted_at", { withTimezone: true }),
    /**
     * Schedules (src/lib/schedules.ts): the schedule controlling the mode now, the mode to go back to when it
     * ends, and the last time a manager changed the mode by hand (a schedule window already running then is
     * skipped, so the manager's change stands until the next window). scheduleLateAlertedAt: "change is late"
     * alert sent for the current change (relay machines).
     */
    scheduleId: bigint("schedule_id", { mode: "number" }),
    modeBeforeSchedule: text("mode_before_schedule"),
    manualModeAt: timestamp("manual_mode_at", { withTimezone: true }),
    scheduleLateAlertedAt: timestamp("schedule_late_alerted_at", { withTimezone: true }),
    /** The pre-start checklist for this machine; null = the organization's default. */
    checklistTemplateId: bigint("checklist_template_id", { mode: "number" }).references(() => checklistTemplates.id, {
      onDelete: "set null",
    }),
    /**
     * Locked out for repair: set when an operator reports a major defect and chooses to lock the machine
     * out. Nobody can check in until a manager clears it. (Physically preventing a start needs the
     * starter relay of Safety & Access Control.)
     */
    /**
     * What the device is told to beep for the operator (src/lib/operator-alerts.ts): none, not_checked_in or
     * checklist_due. Last sent value; a change queues an ALERT command.
     */
    operatorAlert: text("operator_alert").notNull().default("none"),
    lockedOutAt: timestamp("locked_out_at", { withTimezone: true }),
    lockedOutReason: text("locked_out_reason"),
    lockedOutCheckinId: bigint("locked_out_checkin_id", { mode: "number" }),
    /**
     * Low battery warning (src/lib/battery.ts): the first low engine-off reading of a possible low spell,
     * then (confirmed by a second reading a few minutes later) when the warning was raised and the voltage.
     * Cleared when an engine-off reading is healthy again.
     */
    batteryLowPendingAt: timestamp("battery_low_pending_at", { withTimezone: true }),
    batteryLowAt: timestamp("battery_low_at", { withTimezone: true }),
    batteryLowVolts: real("battery_low_volts"),
    /** The engine computer's own hour meter (J1939), when the machine's device reads it, and when it was read. */
    engineHourMeter: doublePrecision("engine_hour_meter"),
    /** Safety (src/lib/safety.ts): the open speeding spell and idle stretch, as safety_events rows, and when idling began. */
    speedingEventId: bigint("speeding_event_id", { mode: "number" }),
    idleSince: timestamp("idle_since", { withTimezone: true }),
    idleEventId: bigint("idle_event_id", { mode: "number" }),
    engineHourMeterAt: timestamp("engine_hour_meter_at", { withTimezone: true }),
    /** The vehicle's own odometer (OBD PID A6 or J1939), when the device reads it, and when it was read. */
    odometerKm: doublePrecision("odometer_km"),
    odometerKmAt: timestamp("odometer_km_at", { withTimezone: true }),
    /** Relay machines (src/lib/relay.ts): the version of the approved-beacon list last sent to the device. */
    accessListHash: text("access_list_hash"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    // Latest state, from whichever device is paired. Null until a device has reported for this machine.
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    lastFixAt: timestamp("last_fix_at", { withTimezone: true }),
    lastLat: doublePrecision("last_lat"),
    lastLng: doublePrecision("last_lng"),
    lastSpeedKph: real("last_speed_kph"),
    lastBatteryV: real("last_battery_v"),
    lastRssi: integer("last_rssi"),
    /** Latest engine state (null = unknown). See src/lib/telemetry/engine.ts. */
    engineOn: boolean("engine_on"),
    engineChangedAt: timestamp("engine_changed_at", { withTimezone: true }),
    /** Since when the device's uploads have had no engine signal (null = the latest one had one). See engineStatus. */
    engineUnknownSince: timestamp("engine_unknown_since", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("machines_code_idx").on(t.code),
    uniqueIndex("machines_org_unit_idx").on(t.organizationId, t.unitNumber).where(sql`${t.unitNumber} is not null`),
  ],
);

/**
 * Which device was on which machine, and when. An open row (no endedAt) is the current pairing:
 * at most one per device and one per machine. Data a device sends while paired belongs to the machine.
 */
export const deviceAssignments = pgTable(
  "device_assignments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("device_assignments_open_device_idx").on(t.deviceId).where(sql`${t.endedAt} is null`),
    uniqueIndex("device_assignments_open_machine_idx").on(t.machineId).where(sql`${t.endedAt} is null`),
    index("device_assignments_machine_idx").on(t.machineId, t.startedAt),
  ],
);

/**
 * One row per physical tracking device (hardware). The device ID is the ID the Freematics firmware
 * generates. A device supplies data for whichever machine it's paired with; the data belongs to the machine.
 */
export const devices = pgTable("devices", {
  id: text("id").primaryKey(),
  /**
   * Whose stock the device is in: a customer's (available to pair with their machines, or already paired)
   * or null = Veristart's (new, in stock, or returned).
   */
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, {
    onDelete: "set null",
  }),
  /** VIN read over OBD, if the vehicle provides one. */
  vin: text("vin"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastFixAt: timestamp("last_fix_at", { withTimezone: true }),
  lastLat: doublePrecision("last_lat"),
  lastLng: doublePrecision("last_lng"),
  lastSpeedKph: real("last_speed_kph"),
  lastBatteryV: real("last_battery_v"),
  lastRssi: integer("last_rssi"),
  /** Latest engine reading from this device (diagnostics; the machine keeps its own engine state). */
  engineOn: boolean("engine_on"),
  engineChangedAt: timestamp("engine_changed_at", { withTimezone: true }),
  /** Firmware version the device last reported (FW= on login, or a finished update), and when. */
  firmwareVersion: text("firmware_version"),
  firmwareReportedAt: timestamp("firmware_reported_at", { withTimezone: true }),
});

/** One row per data sample sent by a device. */
export const telemetry = pgTable(
  "telemetry",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** The machine the device was paired with when this arrived. Null = unpaired (bench test, in stock). */
    machineId: bigint("machine_id", { mode: "number" }).references(() => machines.id, { onDelete: "set null" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /**
     * When the sample was taken: from its GPS time, else the device uptime (src/lib/telemetry/sample-time.ts). Late
     * (backlogged) readings arrive after newer ones, so tracks and charts are ordered by this, not by arrival.
     * Rows from before 2026-10-25 have their arrival time.
     */
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
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
  (t) => [
    index("telemetry_device_time_idx").on(t.deviceId, t.receivedAt),
    index("telemetry_machine_time_idx").on(t.machineId, t.receivedAt),
    index("telemetry_machine_recorded_idx").on(t.machineId, t.recordedAt),
  ],
);

/**
 * What a device reported after restarting (our firmware; docs/device-diagnostics.md): why it restarted and its last
 * log lines (saved on its memory card), for staff diagnosis. The last DIAGNOSTIC_RULES.keepPerDevice are kept.
 */
export const deviceDiagnostics = pgTable(
  "device_diagnostics",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    /** The device's start-up counter (each restart adds one), if sent. */
    bootNumber: integer("boot_number"),
    /** src/lib/restart-reasons.ts key, or what the device sent if unknown. */
    restartReason: text("restart_reason"),
    lines: jsonb("lines").$type<string[]>().notNull(),
  },
  (t) => [index("device_diagnostics_device_time_idx").on(t.deviceId, t.receivedAt)],
);

/** Connection events: login, logout, ping, etc. */
export const deviceEvents = pgTable(
  "device_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** The machine the device was paired with at the time (null = unpaired). */
    machineId: bigint("machine_id", { mode: "number" }).references(() => machines.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
    type: text("type").notNull(),
    rssi: integer("rssi"),
    detail: text("detail"),
  },
  (t) => [
    index("device_events_device_time_idx").on(t.deviceId, t.at),
    index("device_events_machine_time_idx").on(t.machineId, t.at),
  ],
);

/**
 * One row per engine-on period of a machine. An open session has no endedAt.
 * At most one open session per machine (enforced by the partial unique index). A device swap doesn't
 * break a machine's history: the new device continues the machine's sessions.
 */
export const engineSessions = pgTable(
  "engine_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Last report while running; used to close sessions when a device goes silent. */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    /** Which signal detected it: rpm, voltage or vibration. */
    source: text("source"),
    /**
     * Fuel theft check (src/lib/fuel.ts): the tank level settled after this start (%), and when the
     * comparison with the level before it (at the previous stop) was made. Null = not checked yet.
     */
    fuelStartPct: real("fuel_start_pct"),
    fuelCheckedAt: timestamp("fuel_checked_at", { withTimezone: true }),
    /**
     * While running (src/lib/fuel.ts): the reference point the tank level and the engine's fuel meter are
     * compared against (refuels, fuel lost while running), and when that was last checked.
     */
    fuelAnchorPct: real("fuel_anchor_pct"),
    fuelAnchorTotalL: doublePrecision("fuel_anchor_total_l"),
    fuelAnchorAt: timestamp("fuel_anchor_at", { withTimezone: true }),
    fuelRunCheckedAt: timestamp("fuel_run_checked_at", { withTimezone: true }),
  },
  (t) => [
    index("engine_sessions_machine_start_idx").on(t.machineId, t.startedAt),
    uniqueIndex("engine_sessions_one_open_machine_idx").on(t.machineId).where(sql`${t.endedAt} is null`),
  ],
);

/**
 * People who operate machines. They identify themselves on the check-in page with a PIN.
 * PINs are short, so they're a convenience, not strong security: the hash only keeps them out of
 * plain sight in the database, and the check-in page rate-limits wrong guesses.
 */
export const operators = pgTable(
  "operators",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Just a label: names can repeat, even within an organization. The id is what identifies an operator. */
    name: text("name").notNull(),
    /** Optional, unique within the organization. Tells two operators with the same name apart. */
    employeeNumber: text("employee_number"),
    /** Optional contact details: training expiry reminders go to the email (SMS when it's set up). */
    email: text("email"),
    phone: text("phone"),
    /** See hashPin() in src/lib/operators.ts. Unique within the organization: the PIN identifies the operator there. */
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the operator's personal data was erased (src/lib/privacy.ts). The row stays so machine records keep a placeholder. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
    /**
     * The operator's Bluetooth beacon (its advertised name, e.g. VS-BEACON-20). Safety & Access Control machines get
     * the list of approved operators' beacons and let them start without signal (src/lib/relay.ts).
     */
    beaconName: text("beacon_name"),
  },
  (t) => [
    uniqueIndex("operators_org_pin_idx").on(t.organizationId, t.pinHash),
    uniqueIndex("operators_org_employee_idx").on(t.organizationId, t.employeeNumber).where(sql`${t.employeeNumber} is not null`),
    uniqueIndex("operators_org_beacon_idx").on(t.organizationId, t.beaconName).where(sql`${t.beaconName} is not null`),
  ],
);

/**
 * The operator app (src/lib/operator-app.ts; docs/operator-app.md): one-time sign-in codes emailed to an operator's
 * address (only the hash is kept), and the app's sign-ins (one per operator per phone; only the token's hash is kept).
 */
export const operatorLoginCodes = pgTable(
  "operator_login_codes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Lower-case email the code was sent to (it can belong to operators in several companies). */
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
  },
  (t) => [index("operator_login_codes_email_idx").on(t.email, t.createdAt)],
);

export const operatorAppSessions = pgTable(
  "operator_app_sessions",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" })
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** What the phone called itself ("Pixel 8"), so a manager can tell sign-ins apart. */
    deviceName: text("device_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("operator_app_sessions_operator_idx").on(t.operatorId)],
);

/**
 * Which operators may run which machine. A machine with no rows here accepts any active operator.
 */
export const machineOperators = pgTable(
  "machine_operators",
  {
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" })
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.machineId, t.operatorId] })],
);

/**
 * What an answer means, whatever its label: pass (OK), minor or major defect, or not applicable.
 * Minor and major defects raise "Repair needed"; a major defect offers to lock the machine out.
 */
export const SEVERITIES = ["pass", "minor", "major", "na"] as const;
export type Severity = (typeof SEVERITIES)[number];
export type AnswerOption = { key: string; label: string; severity: Severity; color: string };
/**
 * A checklist question. Operators can attach photos to any question; `photoRequired` makes one compulsory,
 * and `photoOnly` makes the photo the whole step (no answer, e.g. "Photo of front"; implies required).
 * `textOnly` makes it a written answer instead of a choice (e.g. "Odometer reading", "Inspection location").
 * Older templates don't have these fields: treat missing as false.
 */
export type ChecklistQuestion = {
  id: string;
  text: string;
  noteRequired: boolean;
  photoRequired?: boolean;
  photoOnly?: boolean;
  textOnly?: boolean;
  /** Written answers only: "place" starts the answer as the city and province where the operator is (editable). */
  prefill?: "place";
};
export type ChecklistSection = { id: string; title: string; questions: ChecklistQuestion[] };

/**
 * One answer as recorded on a check-in, with the question and answer as they were at the time.
 * Check-ins from before customizable checklists only have id, question and ok.
 */
export type ChecklistAnswer = {
  id: string;
  question: string;
  ok: boolean;
  section?: string;
  answer?: string;
  severity?: Severity;
  note?: string;
  /** A photo-only step (the answer is the photo). */
  photoOnly?: boolean;
  /** A written answer (the answer is the text typed). */
  textOnly?: boolean;
};

/** The answers operators choose from (e.g. OK / Minor defect / Major defect / Not applicable). One set per template. */
export const checklistAnswerSets = pgTable(
  "checklist_answer_sets",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    options: jsonb("options").$type<AnswerOption[]>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("checklist_answer_sets_org_name_idx").on(t.organizationId, t.name)],
);

/** A pre-start checklist: sections of questions, one answer set, and the final confirmation the operator signs. */
export const checklistTemplates = pgTable(
  "checklist_templates",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    answerSetId: bigint("answer_set_id", { mode: "number" })
      .notNull()
      .references(() => checklistAnswerSets.id, { onDelete: "restrict" }),
    sections: jsonb("sections").$type<ChecklistSection[]>().notNull(),
    /** The statement the operator confirms at the end (wording can be required by regulations). */
    confirmationText: text("confirmation_text").notNull(),
    /**
     * How often it's needed (src/lib/checklists.ts CHECKLIST_FREQUENCIES): every_checkin, operator_daily (once per
     * operator per machine per day) or machine_daily (once per machine per day, whoever did it). Days are the
     * company's time zone.
     */
    frequency: text("frequency").notNull().default("every_checkin"),
    /** The organization's default, used for machines without a template of their own. Exactly one per organization. */
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("checklist_templates_org_name_idx").on(t.organizationId, t.name),
    uniqueIndex("checklist_templates_one_default_idx").on(t.organizationId).where(sql`${t.isDefault}`),
  ],
);


/**
 * One row per operator check-in (QR code on the machine → PIN → pre-start checklist).
 * Open check-ins have no endedAt. At most one open check-in per machine.
 */
export const checkins = pgTable(
  "checkins",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The machine's organization at the time (a record stays with the customer if the device moves). */
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
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
    /**
     * Checked in without a checklist because today's was already done (the checklist's frequency): the check-in whose
     * checklist covered it. Null = the checklist was done on this check-in.
     */
    checklistFromCheckinId: bigint("checklist_from_checkin_id", { mode: "number" }),
    notes: text("notes"),
    /** The checklist as asked: template name and the confirmation statement the operator agreed to. */
    templateName: text("template_name"),
    confirmationText: text("confirmation_text"),
    /** The operator chose to lock the machine out for repair (after reporting a major defect). */
    lockoutRequested: boolean("lockout_requested").notNull().default(false),
    /** Phone position at check-in (if the operator shared it) and its accuracy radius in metres. */
    phoneLat: doublePrecision("phone_lat"),
    phoneLng: doublePrecision("phone_lng"),
    phoneAccuracyM: real("phone_accuracy_m"),
    /** Distance between the phone and the machine's last GPS position, in metres. */
    distanceM: real("distance_m"),
    /** near, far, no-phone-location or no-machine-location. Null for check-ins made before this check existed. */
    locationCheck: text("location_check"),
    /** The hour meter (hours) or odometer (km) reading the operator gave with the checklist. */
    meterKind: text("meter_kind"),
    meterReading: doublePrecision("meter_reading"),
    /** Relay machines: when the device confirmed it let this check-in start the machine (ALLOW command). */
    relayAllowedAt: timestamp("relay_allowed_at", { withTimezone: true }),
    /**
     * Session hold (app check-ins on relay machines): how long after the engine stops the operator's phone can restart it
     * on this check-in (the company's setting at check-in time). Null = the method's normal break allowance.
     */
    holdMinutes: integer("hold_minutes"),
    /** Times the operator's phone resumed this check-in after a break (the device reported it), and the latest. */
    resumeCount: integer("resume_count").notNull().default(0),
    lastResumedAt: timestamp("last_resumed_at", { withTimezone: true }),
    /**
     * The engine-on period this check-in covers. The operator has a few minutes after checking in to
     * start the engine; the check-in then ends automatically when the engine stops.
     */
    engineSessionId: bigint("engine_session_id", { mode: "number" }).references(() => engineSessions.id, {
      onDelete: "set null",
    }),
    /** How it was linked: started (after check-in), already-running (nobody had it) or takeover (from another operator). */
    engineLink: text("engine_link"),
    /**
     * How the operator checked in: web (QR code + PIN). Later: ble (beacon detected by the device).
     * Decides how long the check-in survives the engine being off (see CHECKIN_RULES.breakMinutes).
     */
    method: text("method").notNull().default("web"),
  },
  (t) => [
    index("checkins_machine_start_idx").on(t.machineId, t.startedAt),
    index("checkins_operator_start_idx").on(t.operatorId, t.startedAt),
    uniqueIndex("checkins_one_open_machine_idx").on(t.machineId).where(sql`${t.endedAt} is null`),
    index("checkins_engine_session_idx").on(t.engineSessionId),
  ],
);

/** Wrong PINs entered on a machine's check-in page, for rate limiting. */
export const pinFailures = pgTable(
  "pin_failures",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    machineId: bigint("machine_id", { mode: "number" }).notNull(),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("pin_failures_machine_time_idx").on(t.machineId, t.at)],
);

/**
 * Alerts for the fleet manager (Tier 2). Each is raised once: per engine-on period for unauthorized use,
 * per check-in for check-in problems (enforced by the unique indexes).
 */
export const alerts = pgTable(
  "alerts",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** unauthorized-use, checklist-failed, not-approved, not-at-machine */
    type: text("type").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    title: text("title").notNull(),
    detail: text("detail"),
    engineSessionId: bigint("engine_session_id", { mode: "number" }).references(() => engineSessions.id, {
      onDelete: "set null",
    }),
    checkinId: bigint("checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    /** For tamper alerts: the incident (one alert when it opens, one more if it escalates to high). */
    incidentId: bigint("incident_id", { mode: "number" }),
    /** For restricted-area alerts: the visit (one alert per entry). */
    worksiteVisitId: bigint("worksite_visit_id", { mode: "number" }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    ackNote: text("ack_note"),
    /** sent, failed or not-configured (no email settings yet). Null while sending. */
    emailStatus: text("email_status"),
    emailError: text("email_error"),
  },
  (t) => [
    index("alerts_created_idx").on(t.createdAt),
    index("alerts_machine_created_idx").on(t.machineId, t.createdAt),
    uniqueIndex("alerts_one_per_engine_session_idx").on(t.type, t.engineSessionId),
    uniqueIndex("alerts_one_per_checkin_idx").on(t.type, t.checkinId),
    uniqueIndex("alerts_one_per_incident_idx").on(t.type, t.incidentId),
    uniqueIndex("alerts_one_per_visit_idx").on(t.type, t.worksiteVisitId),
  ],
);

/**
 * A user's notification rule ("subscription"): which events, on which machines / by which operators, when,
 * and how they're told. Empty lists mean "all". Users only hear about machines they can see.
 * Matching: src/lib/notifications.ts.
 */
export const notificationRules = pgTable(
  "notification_rules",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" })
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Keys of EVENT_TYPES in src/lib/notifications.ts. */
    eventTypes: text("event_types").array().notNull(),
    /** Empty = all machines (that the user can see). A machine matches if listed, or in a listed division. */
    machineIds: bigint("machine_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    divisionIds: bigint("division_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** Empty = any operator. When set, events without an operator don't match. */
    operatorIds: bigint("operator_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** For worksite events only: empty = any worksite. Other event types ignore it. */
    worksiteIds: bigint("worksite_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** 0 = Sunday … 6 = Saturday. Empty = every day. */
    weekdays: integer("weekdays").array().notNull().default(sql`'{}'`),
    /** "HH:mm", or "" for any time. A window like 18:00–06:00 runs overnight. */
    startTime: text("start_time").notNull().default(""),
    endTime: text("end_time").notNull().default(""),
    /** The schedule's time zone (set from APP_TIMEZONE each time the rule is saved). */
    timezone: text("timezone").notNull(),
    /** email for now; sms later. Email goes to the user's sign-in address. */
    channels: text("channels").array().notNull().default(sql`'{email}'`),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notification_rules_org_idx").on(t.organizationId), index("notification_rules_user_idx").on(t.userId)],
);

/**
 * Things that happened that people can be notified about: engine starts/stops, alerts, machine and
 * approval changes. Recorded first, then matched against rules and delivered in the background.
 */
export const notificationEvents = pgTable(
  "notification_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    /** Null for events about an operator rather than a machine (training reminders). */
    machineId: bigint("machine_id", { mode: "number" }).references(() => machines.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    /** Filled in from the check-in when the event is processed (start/stop), or when recorded. */
    operatorId: bigint("operator_id", { mode: "number" }).references(() => operators.id, { onDelete: "set null" }),
    engineSessionId: bigint("engine_session_id", { mode: "number" }).references(() => engineSessions.id, { onDelete: "set null" }),
    alertId: bigint("alert_id", { mode: "number" }).references(() => alerts.id, { onDelete: "set null" }),
    /** Worksite events: the worksite and the visit (one enter / leave / stayed-too-long event per visit). */
    worksiteId: bigint("worksite_id", { mode: "number" }).references(() => worksites.id, { onDelete: "set null" }),
    worksiteVisitId: bigint("worksite_visit_id", { mode: "number" }).references(() => worksiteVisits.id, { onDelete: "set null" }),
    /** Extra detail for the message, e.g. what changed. */
    detail: text("detail"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
    /** Null until matched and delivered. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("notification_events_org_time_idx").on(t.organizationId, t.occurredAt),
    index("notification_events_pending_idx").on(t.machineId).where(sql`${t.processedAt} is null`),
    uniqueIndex("notification_events_one_per_session_idx").on(t.type, t.engineSessionId),
    uniqueIndex("notification_events_one_per_alert_idx").on(t.alertId),
    uniqueIndex("notification_events_one_per_visit_idx").on(t.type, t.worksiteVisitId),
  ],
);

/** Who was sent what. One per event, person and channel, whatever number of their rules matched. */
export const notificationDeliveries = pgTable(
  "notification_deliveries",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    eventId: bigint("event_id", { mode: "number" })
      .notNull()
      .references(() => notificationEvents.id, { onDelete: "cascade" }),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, { onDelete: "cascade" }),
    /** The rule names that matched, for the email and the preview. */
    ruleNames: text("rule_names").array().notNull(),
    channel: text("channel").notNull(),
    recipient: text("recipient").notNull(),
    /** sent, failed, not-configured */
    status: text("status").notNull(),
    error: text("error"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("notification_deliveries_once_idx").on(t.eventId, t.userId, t.channel)],
);

/**
 * Maintenance work items (src/lib/maintenance.ts; docs/maintenance.md; modelled on Veristart Insights' maintenance
 * module): checklist defects, service schedules coming due, devices offline, and items staff add. Each follows the
 * "three C's": complaint (what was reported), cause, correction. One open item per `dedupe_key` (a checklist question
 * on a machine, a schedule, a machine's connectivity): a defect reported again is added to the open item as another
 * report (maintenance_reports) instead of a new item. Replaces checklist_issues (2026-10-26).
 */
export const maintenanceIssues = pgTable(
  "maintenance_issues",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** Shown as #1001 …, per organization. */
    number: integer("number").notNull(),
    /** checklist / schedule / connectivity / manual. */
    source: text("source").notNull(),
    /** lockout / major / overdue_pm / minor / connectivity / low (src/lib/maintenance-types.ts). */
    priority: text("priority").notNull(),
    /** new / in_progress / awaiting_parts / resolved. */
    status: text("status").notNull().default("new"),
    title: text("title").notNull(),
    complaint: text("complaint").notNull().default(""),
    cause: text("cause"),
    correction: text("correction"),
    /** internal / vendor (who did the work), and the vendor's name. */
    performedBy: text("performed_by"),
    vendorName: text("vendor_name"),
    /** One open item per key: checklist:<questionId>, schedule:<id>, connectivity. Null = never merged (manual). */
    dedupeKey: text("dedupe_key"),
    // Checklist defects: the question, the most severe report so far, and the latest answer.
    questionId: text("question_id"),
    section: text("section"),
    severity: text("severity"),
    answerLabel: text("answer_label"),
    note: text("note"),
    reportCount: integer("report_count").notNull().default(1),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull(),
    firstCheckinId: bigint("first_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    lastCheckinId: bigint("last_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    /** The check-in that last raised a "Repair needed" alert for this item (when new, or escalated). */
    alertCheckinId: bigint("alert_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    /** Service items: the schedule, and the machine's reading when the work was done (sets the next due). */
    scheduleId: bigint("schedule_id", { mode: "number" }).references(() => maintenanceSchedules.id, { onDelete: "set null" }),
    servicedHours: doublePrecision("serviced_hours"),
    servicedKm: doublePrecision("serviced_km"),
    /** YYYY-MM-DD in the company time zone. */
    servicedOn: text("serviced_on"),
    /** Where the machine was when it was reported. */
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    worksiteId: bigint("worksite_id", { mode: "number" }).references(() => worksites.id, { onDelete: "set null" }),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: bigint("resolved_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
  },
  (t) => [
    uniqueIndex("maintenance_issues_number_idx").on(t.organizationId, t.number),
    uniqueIndex("maintenance_issues_one_open_idx")
      .on(t.machineId, t.dedupeKey)
      .where(sql`${t.resolvedAt} is null and ${t.dedupeKey} is not null`),
    index("maintenance_issues_org_idx").on(t.organizationId, t.resolvedAt),
    index("maintenance_issues_machine_idx").on(t.machineId, t.lastReportedAt),
    index("maintenance_issues_alert_checkin_idx").on(t.alertCheckinId),
  ],
);

/** Each checklist that reported a maintenance item (the first and every repeat), with that report's answer and note. */
export const maintenanceReports = pgTable(
  "maintenance_reports",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => maintenanceIssues.id, { onDelete: "cascade" }),
    /** Null once the check-in is deleted by the retention clean-up (the report stays). */
    checkinId: bigint("checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    reportedAt: timestamp("reported_at", { withTimezone: true }).notNull(),
    answerLabel: text("answer_label").notNull(),
    severity: text("severity").notNull(),
    note: text("note"),
  },
  (t) => [index("maintenance_reports_issue_idx").on(t.issueId, t.reportedAt), index("maintenance_reports_checkin_idx").on(t.checkinId)],
);

/** Files staff attach to a maintenance item, per section (complaint / cause / correction). Private storage. */
export const maintenanceAttachments = pgTable(
  "maintenance_attachments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => maintenanceIssues.id, { onDelete: "cascade" }),
    section: text("section").notNull(),
    storageKey: text("storage_key").notNull(),
    filename: text("filename").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    uploadedByUserId: bigint("uploaded_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("maintenance_attachments_issue_idx").on(t.issueId)],
);

/** What happened to a maintenance item, in words ("Status: In progress → Resolved"). */
export const maintenanceActivity = pgTable(
  "maintenance_activity",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    issueId: bigint("issue_id", { mode: "number" })
      .notNull()
      .references(() => maintenanceIssues.id, { onDelete: "cascade" }),
    /** Null = VS-lab itself (a checklist, a schedule, the watchdog). */
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    at: timestamp("at", { withTimezone: true }).notNull(),
    kind: text("kind").notNull(),
    detail: text("detail").notNull(),
  },
  (t) => [index("maintenance_activity_issue_idx").on(t.issueId, t.at)],
);

/**
 * Preventive maintenance: a service every N days and/or N engine hours and/or N km, whichever comes first. Due
 * soon in the last 10% of the interval; due (an open "Service due" item) once any is reached. Resolving that item
 * sets the next due from the reading at service.
 */
export const maintenanceSchedules = pgTable(
  "maintenance_schedules",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    description: text("description").notNull(),
    everyDays: integer("every_days"),
    everyHours: doublePrecision("every_hours"),
    everyKm: doublePrecision("every_km"),
    /** YYYY-MM-DD (company time zone). */
    nextDueOn: text("next_due_on"),
    nextDueHours: doublePrecision("next_due_hours"),
    nextDueKm: doublePrecision("next_due_km"),
    lastServicedAt: timestamp("last_serviced_at", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("maintenance_schedules_machine_idx").on(t.machineId)],
);

/**
 * Hour meter and odometer readings (src/lib/meters.ts): from checklists, typed in by staff, or at a service. The
 * engine computer's own readings stay on the machine (engine_hour_meter, odometer_km) and aren't copied here.
 */
export const meterReadings = pgTable(
  "meter_readings",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** hours / km. */
    kind: text("kind").notNull(),
    value: doublePrecision("value").notNull(),
    /** checklist / manual / service. */
    source: text("source").notNull(),
    checkinId: bigint("checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    userId: bigint("user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("meter_readings_machine_idx").on(t.machineId, t.kind, t.recordedAt)],
);

/** Place names ("Mount Pearl, NL") for ~1 km squares, from OpenStreetMap Nominatim (src/lib/places.ts). */
export const placeNames = pgTable("place_names", {
  key: text("key").primaryKey(),
  name: text("name"),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

/**
 * Photos taken during a check-in, one row per photo, attached to a checklist question. The file is in
 * private storage (Vercel Blob, or a local folder in development: src/lib/photos.ts) and is only served
 * to signed-in users who can see the machine.
 */
export const checkinPhotos = pgTable(
  "checkin_photos",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    checkinId: bigint("checkin_id", { mode: "number" })
      .notNull()
      .references(() => checkins.id, { onDelete: "cascade" }),
    questionId: text("question_id").notNull(),
    /** Where the file is, inside the photo storage. */
    storageKey: text("storage_key").notNull(),
    contentType: text("content_type").notNull(),
    bytes: integer("bytes").notNull(),
    takenAt: timestamp("taken_at", { withTimezone: true }).notNull(),
    /** For a future AI review of the photo (e.g. damage found). Null = not analysed. */
    analysis: jsonb("analysis"),
  },
  (t) => [index("checkin_photos_checkin_idx").on(t.checkinId), index("checkin_photos_machine_question_idx").on(t.machineId, t.questionId)],
);

/**
 * Possible tampering or connectivity problems with a machine's tracking device, found by the watchdog
 * (src/lib/tamper.ts): a device that went quiet, came back somewhere else, came back reporting a different
 * vehicle, or restarted without signing off (power cut). Each has a concern level and the reasons for it.
 */
export const deviceIncidents = pgTable(
  "device_incidents",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** silent, moved-while-silent, vin-changed, power-interrupted */
    kind: text("kind").notNull(),
    /** low, medium, high */
    concern: text("concern").notNull(),
    /** Plain-language reasons for the concern level. */
    reasons: text("reasons").array().notNull(),
    /** The device's state when it was last heard from. */
    lastContactAt: timestamp("last_contact_at", { withTimezone: true }).notNull(),
    lastRssi: integer("last_rssi"),
    lastBatteryV: real("last_battery_v"),
    engineWasOn: boolean("engine_was_on"),
    /** The device said goodbye (went to sleep normally) before going quiet. */
    signedOff: boolean("signed_off").notNull().default(false),
    lastLat: doublePrecision("last_lat"),
    lastLng: doublePrecision("last_lng"),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull(),
    /** When it was last re-scored (e.g. medium → high after a second missed heartbeat). */
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    /** Null while open (still quiet). Set when the device reports again, or straight away for one-off findings. */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolution: text("resolution"),
    /** Bookkeeping for notifications: the highest concern already alerted, and the connectivity messages sent. */
    alertedConcern: text("alerted_concern"),
    offlineNotified: boolean("offline_notified").notNull().default(false),
    onlineNotified: boolean("online_notified").notNull().default(false),
    /** After a quiet spell ends: whether the first GPS position back has been compared with the last one. */
    movementChecked: boolean("movement_checked").notNull().default(false),
  },
  (t) => [
    uniqueIndex("device_incidents_one_open_silent_idx").on(t.machineId).where(sql`${t.kind} = 'silent' and ${t.resolvedAt} is null`),
    index("device_incidents_machine_idx").on(t.machineId, t.openedAt),
  ],
);

/**
 * Places drawn on the map ("geo-lock"): jobsites, yards, offices, customer sites. Machines are matched to
 * them by GPS position (src/lib/worksites.ts); entering, leaving and staying too long are notification events.
 */
export const worksites = pgTable(
  "worksites",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Keys of WORKSITE_TYPES in src/lib/worksite-types.ts (worksite, company_facility, yard_storage…). */
    type: text("type").notNull(),
    notes: text("notes"),
    /** The boundary: [lat, lng] corners in order (not closed; at least 3). */
    polygon: jsonb("polygon").$type<[number, number][]>().notNull(),
    centerLat: doublePrecision("center_lat").notNull(),
    centerLng: doublePrecision("center_lng").notNull(),
    /** "Stays too long": a notification when a machine has been here longer than this. Null = no limit. */
    dwellLimitMinutes: integer("dwell_limit_minutes"),
    /** Site speed limit (km/h); null = the fleet limit applies. */
    speedLimitKph: real("speed_limit_kph"),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("worksites_org_name_idx").on(t.organizationId, t.name)],
);

/** A machine's time inside a worksite: open (no leftAt) while it's there. At most one open visit per machine and site. */
export const worksiteVisits = pgTable(
  "worksite_visits",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    worksiteId: bigint("worksite_id", { mode: "number" })
      .notNull()
      .references(() => worksites.id, { onDelete: "cascade" }),
    enteredAt: timestamp("entered_at", { withTimezone: true }).notNull(),
    /** The last GPS position inside (a visit ends at this time when the machine is seen leaving). */
    lastInsideAt: timestamp("last_inside_at", { withTimezone: true }).notNull(),
    leftAt: timestamp("left_at", { withTimezone: true }),
    /** When the "stayed too long" notification was recorded for this visit. */
    dwellNotifiedAt: timestamp("dwell_notified_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("worksite_visits_one_open_idx").on(t.machineId, t.worksiteId).where(sql`${t.leftAt} is null`),
    index("worksite_visits_machine_idx").on(t.machineId, t.enteredAt),
    index("worksite_visits_site_idx").on(t.worksiteId, t.enteredAt),
  ],
);

/**
 * Fault codes reported by a machine's engine computer (J1939 DM1): one row per fault while it's active,
 * closed (clearedAt) when the engine stops reporting it. src/lib/faults.ts.
 */
export const machineFaults = pgTable(
  "machine_faults",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** Suspect parameter number (what) and failure mode identifier (how). */
    spn: integer("spn").notNull(),
    fmi: integer("fmi").notNull(),
    /** DM1 lamp bits when it was last reported (2 = red stop, 4 = amber warning, 1 = malfunction, 8 = protect). */
    lamps: integer("lamps"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("machine_faults_one_active_idx").on(t.machineId, t.spn, t.fmi).where(sql`${t.clearedAt} is null`),
    index("machine_faults_machine_idx").on(t.machineId, t.firstSeenAt),
  ],
);

/**
 * The fuel log (src/lib/fuel.ts): refuels, and suspected thefts (while parked, or while running) that also
 * raised an alert. Worked out from the tank level and, on J1939 machines, the engine's fuel meter.
 */
export const fuelEvents = pgTable(
  "fuel_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    engineSessionId: bigint("engine_session_id", { mode: "number" }).references(() => engineSessions.id, { onDelete: "set null" }),
    /** refuel, theft (dropped while parked), loss (dropped while running, more than the engine burned) */
    kind: text("kind").notNull(),
    /** refuel: parked or running */
    when: text("when").notNull(),
    at: timestamp("at", { withTimezone: true }).notNull(),
    fromPct: real("from_pct").notNull(),
    toPct: real("to_pct").notNull(),
    /** Litres added or missing, when the tank size is known. */
    litres: real("litres"),
    alertId: bigint("alert_id", { mode: "number" }).references(() => alerts.id, { onDelete: "set null" }),
  },
  (t) => [index("fuel_events_machine_idx").on(t.machineId, t.at), index("fuel_events_org_idx").on(t.organizationId, t.at)],
);

/**
 * Commands for a device (src/lib/commands.ts): queued by Veristart staff, sent in the reply to the device's
 * next report or check-in (our firmware fork reads them; the stock firmware ignores them), and answered by
 * the device at /hub/api/ack. pending → sent → done / failed, or expired / cancelled.
 */
export const deviceCommands = pgTable(
  "device_commands",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    /** The command line the device runs, e.g. "BEEP=3" (see COMMANDS). */
    command: text("command").notNull(),
    /** Plain-language description for the history, e.g. "Sound the buzzer 3 times". */
    label: text("label").notNull(),
    status: text("status").notNull().default("pending"),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Sent in a reply this many times (resent until answered, up to a limit); the last time. */
    sendCount: integer("send_count").notNull().default(0),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    /** The device's answer (e.g. "OK", a value, or an error). */
    result: text("result"),
    /** For firmware updates: the release being installed (src/lib/firmware.ts). */
    firmwareReleaseId: bigint("firmware_release_id", { mode: "number" }).references(() => firmwareReleases.id, { onDelete: "set null" }),
  },
  (t) => [
    index("device_commands_device_idx").on(t.deviceId, t.createdAt),
    index("device_commands_release_idx").on(t.firmwareReleaseId),
  ],
);

/** Firmware builds staff have uploaded for over-the-air updates (src/lib/firmware.ts; docs/firmware-updates.md). */
export const firmwareReleases = pgTable("firmware_releases", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** As the firmware reports it (FW=), e.g. "vs-1.0.3". Unique. */
  version: text("version").notNull().unique(),
  notes: text("notes"),
  fileName: text("file_name").notNull(),
  /** Where the file is kept (private Blob store, or .data/firmware locally). */
  storageKey: text("storage_key").notNull(),
  /** SHA-256 of the file (hex): the device checks it before installing. */
  sha256: text("sha256").notNull(),
  bytes: integer("bytes").notNull(),
  uploadedBy: text("uploaded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  /** Retired releases can't be sent to more devices. */
  retiredAt: timestamp("retired_at", { withTimezone: true }),
});

/**
 * The safety log (src/lib/safety.ts): speeding spells, restricted-area entries, excessive idling and operator
 * fatigue (later: harsh braking, impacts, rollover, tilt from our firmware). One row per occurrence.
 */
export const safetyEvents = pgTable(
  "safety_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" }).references(() => machines.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" }).references(() => operators.id, { onDelete: "set null" }),
    worksiteId: bigint("worksite_id", { mode: "number" }).references(() => worksites.id, { onDelete: "set null" }),
    /** speeding, restricted_area, excessive_idle, fatigue_daily, fatigue_continuous */
    kind: text("kind").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    /** Null while it's going on (speeding, idling). */
    endedAt: timestamp("ended_at", { withTimezone: true }),
    /** Highest value (km/h, minutes, hours) and the limit it was measured against. */
    peak: real("peak"),
    limitValue: real("limit_value"),
    detail: text("detail"),
    /** When it was notified (speeding and idling are only notified once they've lasted long enough). */
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    /** Stops the same occurrence being recorded twice (e.g. fatigue: operator + day). */
    dedupeKey: text("dedupe_key"),
  },
  (t) => [
    index("safety_events_org_time_idx").on(t.organizationId, t.startedAt),
    index("safety_events_machine_idx").on(t.machineId, t.startedAt),
    uniqueIndex("safety_events_dedupe_idx").on(t.dedupeKey),
  ],
);

export type Organization = typeof organizations.$inferSelect;
export type SafetyEvent = typeof safetyEvents.$inferSelect;

/**
 * Roads with their posted speed limits from OpenStreetMap, cached per map square (src/lib/posted-speed.ts). Shared by
 * all organizations (public map data); refreshed after a month.
 */
export const roadTiles = pgTable("road_tiles", {
  key: text("key").primaryKey(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  roads: jsonb("roads").$type<CachedRoad[]>().notNull(),
});
export type CachedRoad = {
  id: number;
  name: string | null;
  highway: string;
  /** 1 = one way along the points, -1 = one way against them, 0 = both ways. */
  oneway: number;
  /** km/h; forward/backward limits when they differ by direction. Null = not recorded. */
  limit: number | null;
  forward: number | null;
  backward: number | null;
  points: [number, number][];
};

/**
 * Road kilometres driven by on-road vehicles per month, by whether the posted limit was known (OpenStreetMap
 * coverage, to decide when paid map data is worth it). Off-road = not on a mapped road (yards, worksites).
 */
export const roadCoverage = pgTable(
  "road_coverage",
  {
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    month: text("month").notNull(),
    knownKm: doublePrecision("known_km").notNull().default(0),
    unknownKm: doublePrecision("unknown_km").notNull().default(0),
    offRoadKm: doublePrecision("off_road_km").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.month] })],
);
export type DeviceCommand = typeof deviceCommands.$inferSelect;
export type FirmwareRelease = typeof firmwareReleases.$inferSelect;
export type FuelEvent = typeof fuelEvents.$inferSelect;
export type MachineFault = typeof machineFaults.$inferSelect;
export type Worksite = typeof worksites.$inferSelect;
export type WorksiteVisit = typeof worksiteVisits.$inferSelect;
export type AuditLogEntry = typeof auditLog.$inferSelect;
export type DeviceIncident = typeof deviceIncidents.$inferSelect;
export type CheckinPhoto = typeof checkinPhotos.$inferSelect;
export type ChecklistTemplate = typeof checklistTemplates.$inferSelect;
export type ChecklistAnswerSet = typeof checklistAnswerSets.$inferSelect;
export type MaintenanceIssue = typeof maintenanceIssues.$inferSelect;
export type MaintenanceSchedule = typeof maintenanceSchedules.$inferSelect;
export type NotificationRule = typeof notificationRules.$inferSelect;
export type NotificationEvent = typeof notificationEvents.$inferSelect;
export type Division = typeof divisions.$inferSelect;
export type User = typeof users.$inferSelect;
export type Role = (typeof roleEnum.enumValues)[number];
export type Device = typeof devices.$inferSelect;
export type Machine = typeof machines.$inferSelect;
export type DeviceAssignment = typeof deviceAssignments.$inferSelect;
export type Alert = typeof alerts.$inferSelect;
export type TelemetryRow = typeof telemetry.$inferSelect;
export type DeviceEvent = typeof deviceEvents.$inferSelect;
export type EngineSession = typeof engineSessions.$inferSelect;
export type Operator = typeof operators.$inferSelect;
export type Checkin = typeof checkins.$inferSelect;
export type Tier = (typeof tierEnum.enumValues)[number];

/**
 * Privacy breach register (src/lib/breaches.ts; docs/privacy-canada.md). PIPEDA requires a record of every breach
 * of security safeguards involving personal information, kept at least 24 months, whether or not it was reported.
 * Staff only. Never deleted by the retention clean-up.
 */
export const breachRecords = pgTable("breach_records", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  /** When it happened (if known) and when we found out. */
  occurredAt: timestamp("occurred_at", { withTimezone: true }),
  discoveredAt: timestamp("discovered_at", { withTimezone: true }).notNull(),
  /** What happened, and what personal information was involved. */
  description: text("description").notNull(),
  dataInvolved: text("data_involved"),
  /** Which customers and roughly how many people. */
  organizationsAffected: text("organizations_affected"),
  peopleAffected: integer("people_affected"),
  /** Real risk of significant harm: null = not assessed yet. If yes, report to the Commissioner and notify people. */
  realRiskOfSignificantHarm: boolean("real_risk_of_significant_harm"),
  riskReasoning: text("risk_reasoning"),
  reportedToCommissionerAt: timestamp("reported_to_commissioner_at", { withTimezone: true }),
  individualsNotifiedAt: timestamp("individuals_notified_at", { withTimezone: true }),
  customersNotifiedAt: timestamp("customers_notified_at", { withTimezone: true }),
  /** What was done to contain it and stop it happening again. */
  actionsTaken: text("actions_taken"),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  recordedBy: text("recorded_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export type BreachRecord = typeof breachRecords.$inferSelect;

/** Every operating-mode change, for the machine page history and audit (src/lib/modes.ts). */
export const machineModeChanges = pgTable(
  "machine_mode_changes",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    until: timestamp("until", { withTimezone: true }),
    reason: text("reason"),
    /** manager, schedule or timer */
    source: text("source").notNull(),
    scheduleId: bigint("schedule_id", { mode: "number" }),
    changedBy: text("changed_by"),
    at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("machine_mode_changes_machine_idx").on(t.machineId, t.at)],
);
export type MachineModeChange = typeof machineModeChanges.$inferSelect;

/**
 * Schedules (src/lib/schedules.ts, src/lib/schedule-time.ts; docs/schedules.md): future machine-mode changes and
 * temporary operator access. Times are wall-clock in the schedule's own timezone.
 */
export const schedules = pgTable(
  "schedules",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** active or paused */
    status: text("status").notNull().default("active"),
    /** machine_mode or operator_access */
    action: text("action").notNull(),
    mode: text("mode"),
    /** Empty = all machines the creator can manage (machine mode only). */
    machineIds: bigint("machine_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    operatorIds: bigint("operator_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** once, weekly or override */
    recurrence: text("recurrence").notNull(),
    timezone: text("timezone").notNull(),
    /** One-time and override: YYYY-MM-DD and HH:MM. */
    startDate: text("start_date"),
    startTime: text("start_time"),
    endDate: text("end_date"),
    endTime: text("end_time"),
    /** One-time machine mode: keep the mode until changed by hand. */
    noEnd: boolean("no_end").notNull().default(false),
    /** Weekly: days (0 = Sunday), all day, and the dates it runs between (YYYY-MM-DD; null = open). */
    weekdays: integer("weekdays").array().notNull().default(sql`'{}'`),
    allDay: boolean("all_day").notNull().default(false),
    effectiveFrom: text("effective_from"),
    effectiveUntil: text("effective_until"),
    /** revert or set_mode (+ endMode). */
    endBehavior: text("end_behavior").notNull().default("revert"),
    endMode: text("end_mode"),
    remindBeforeExpiry: boolean("remind_before_expiry").notNull().default(false),
    reminderSentFor: timestamp("reminder_sent_for", { withTimezone: true }),
    createdByUserId: bigint("created_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    createdBy: text("created_by").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("schedules_org_idx").on(t.organizationId)],
);
export type Schedule = typeof schedules.$inferSelect;

/** Machine categories, per company (defaults + their own; src/lib/training.ts). Certifications cover categories. */
export const machineCategories = pgTable(
  "machine_categories",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => [uniqueIndex("machine_categories_org_name_idx").on(t.organizationId, t.name)],
);

/**
 * Certification types (src/lib/training.ts; docs/training.md): what a training record proves, how long it lasts,
 * which machines it covers, and whether it grants access to them (autoGrant) and/or is required for them.
 */
export const certificationTypes = pgTable(
  "certification_types",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Default validity from the issue date; null = doesn't expire. */
    validityMonths: integer("validity_months"),
    categoryIds: bigint("category_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    machineIds: bigint("machine_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** A valid record gives access to every covered machine. */
    autoGrant: boolean("auto_grant").notNull().default(false),
    /** Without a valid record, operators can't check in on covered machines (even if approved by hand). */
    required: boolean("required").notNull().default(false),
    /** Days after expiry that the record still counts (with warnings). */
    graceDays: integer("grace_days").notNull().default(0),
    /** Days before expiry to send reminders. */
    reminderDays: integer("reminder_days").array().notNull().default(sql`'{60,30,7}'`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("certification_types_org_name_idx").on(t.organizationId, t.name)],
);

/** An operator's training record / certificate (entered by a manager; src/lib/training.ts). */
export const trainingRecords = pgTable(
  "training_records",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    operatorId: bigint("operator_id", { mode: "number" })
      .notNull()
      .references(() => operators.id, { onDelete: "cascade" }),
    certificationTypeId: bigint("certification_type_id", { mode: "number" })
      .notNull()
      .references(() => certificationTypes.id, { onDelete: "cascade" }),
    /** YYYY-MM-DD (calendar dates; compared in the company timezone). */
    issuedOn: text("issued_on").notNull(),
    expiresOn: text("expires_on"),
    provider: text("provider"),
    certificateNumber: text("certificate_number"),
    notes: text("notes"),
    /** The scanned or uploaded document (private storage), if kept. */
    documentKey: text("document_key"),
    documentType: text("document_type"),
    enteredBy: text("entered_by").notNull(),
    enteredByUserId: bigint("entered_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    /** Reminders: the smallest "days before" already sent for the current expiry date, and when "expired" was sent. */
    remindedDays: integer("reminded_days"),
    expiredNotifiedAt: timestamp("expired_notified_at", { withTimezone: true }),
  },
  (t) => [index("training_records_operator_idx").on(t.operatorId), index("training_records_org_expiry_idx").on(t.organizationId, t.expiresOn)],
);
export type MachineCategory = typeof machineCategories.$inferSelect;
export type CertificationType = typeof certificationTypes.$inferSelect;
export type TrainingRecord = typeof trainingRecords.$inferSelect;
