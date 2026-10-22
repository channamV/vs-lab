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
  workingDays: integer("working_days").array().notNull().default(sql`'{1,2,3,4,5}'`),
  /** Fleet timezone (IANA): the default for new schedules (src/lib/schedules.ts). */
  timezone: text("timezone").notNull().default("America/Toronto"),
  /** When schedules overlap and disagree: least_restrictive (default) or most_restrictive. Veristart admins only. */
  scheduleConflictRule: text("schedule_conflict_rule").notNull().default("least_restrictive"),
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
    make: text("make"),
    model: text("model"),
    year: integer("year"),
    /** Serial number or VIN. */
    serialNumber: text("serial_number"),
    /** Fuel tank size in litres (optional): turns fuel-level drops into litres for the fuel theft alert. */
    fuelTankLitres: real("fuel_tank_litres"),
    /** This machine's own top speed (km/h) for the Speeding notification; replaces the fleet limit. Null = fleet limit. */
    speedLimitKph: real("speed_limit_kph"),
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
  ],
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
    /** See hashPin() in src/lib/operators.ts. Unique within the organization: the PIN identifies the operator there. */
    pinHash: text("pin_hash").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /** Set when the operator's personal data was erased (src/lib/privacy.ts). The row stays so machine records keep a placeholder. */
    erasedAt: timestamp("erased_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("operators_org_pin_idx").on(t.organizationId, t.pinHash),
    uniqueIndex("operators_org_employee_idx").on(t.organizationId, t.employeeNumber).where(sql`${t.employeeNumber} is not null`),
  ],
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
 * Older templates don't have the photo fields: treat missing as false.
 */
export type ChecklistQuestion = { id: string; text: string; noteRequired: boolean; photoRequired?: boolean; photoOnly?: boolean };
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
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
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
 * Defects reported on pre-start checklists, one open row per machine and question. A defect reported
 * again stacks onto the open issue (count + latest report) instead of creating another; reporting it
 * as more severe escalates it. Managers resolve issues. (A maintenance module will build on this.)
 */
export const checklistIssues = pgTable(
  "checklist_issues",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    organizationId: bigint("organization_id", { mode: "number" })
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    machineId: bigint("machine_id", { mode: "number" })
      .notNull()
      .references(() => machines.id, { onDelete: "cascade" }),
    /** The template question's id; with the machine, this is what stacks repeat reports. */
    questionId: text("question_id").notNull(),
    question: text("question").notNull(),
    section: text("section"),
    /** minor or major (the most severe reported so far). */
    severity: text("severity").notNull(),
    /** The latest answer's label and note, e.g. "Minor defect", "buckle sticks". */
    answerLabel: text("answer_label").notNull(),
    note: text("note"),
    reportCount: integer("report_count").notNull().default(1),
    firstReportedAt: timestamp("first_reported_at", { withTimezone: true }).notNull(),
    lastReportedAt: timestamp("last_reported_at", { withTimezone: true }).notNull(),
    firstCheckinId: bigint("first_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    lastCheckinId: bigint("last_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    /** The check-in that last raised a "Repair needed" alert for this issue (when new, or escalated). */
    alertCheckinId: bigint("alert_checkin_id", { mode: "number" }).references(() => checkins.id, { onDelete: "set null" }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolvedByUserId: bigint("resolved_by_user_id", { mode: "number" }).references(() => users.id, { onDelete: "set null" }),
    resolutionNote: text("resolution_note"),
  },
  (t) => [
    uniqueIndex("checklist_issues_one_open_idx").on(t.machineId, t.questionId).where(sql`${t.resolvedAt} is null`),
    index("checklist_issues_machine_idx").on(t.machineId, t.lastReportedAt),
    index("checklist_issues_alert_checkin_idx").on(t.alertCheckinId),
  ],
);

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
export type ChecklistIssue = typeof checklistIssues.$inferSelect;
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
