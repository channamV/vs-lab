CREATE TABLE "device_assignments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"machine_id" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "machines" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"unit_number" text,
	"machine_type" text,
	"make" text,
	"model" text,
	"year" integer,
	"serial_number" text,
	"tier" "tier" DEFAULT 'gps' NOT NULL,
	"disarmed" boolean DEFAULT false NOT NULL,
	"disarmed_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone,
	"last_fix_at" timestamp with time zone,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_speed_kph" real,
	"last_battery_v" real,
	"last_rssi" integer,
	"engine_on" boolean,
	"engine_changed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "device_events" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "machine_operators" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "pin_failures" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "machine_id" bigint;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_assignments" ADD CONSTRAINT "device_assignments_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_open_device_idx" ON "device_assignments" USING btree ("device_id") WHERE "device_assignments"."ended_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "device_assignments_open_machine_idx" ON "device_assignments" USING btree ("machine_id") WHERE "device_assignments"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "device_assignments_machine_idx" ON "device_assignments" USING btree ("machine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_code_idx" ON "machines" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "machines_org_unit_idx" ON "machines" USING btree ("organization_id","unit_number") WHERE "machines"."unit_number" is not null;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD CONSTRAINT "engine_sessions_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_operators" ADD CONSTRAINT "machine_operators_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_events_machine_time_idx" ON "device_events" USING btree ("machine_id","at");--> statement-breakpoint
CREATE INDEX "telemetry_machine_time_idx" ON "telemetry" USING btree ("machine_id","received_at");--> statement-breakpoint
-- Each device that belongs to an organization becomes a machine, paired with it since the device first
-- reported. The machine's QR code is the old device ID, so QR stickers already printed keep working.--> statement-breakpoint
INSERT INTO "machines" ("organization_id", "code", "name", "tier", "disarmed", "disarmed_until", "created_at", "last_seen_at", "last_fix_at", "last_lat", "last_lng", "last_speed_kph", "last_battery_v", "last_rssi", "engine_on", "engine_changed_at")
SELECT "organization_id", "id", coalesce("name", "id"), "tier", "disarmed", "disarmed_until", "first_seen_at", "last_seen_at", "last_fix_at", "last_lat", "last_lng", "last_speed_kph", "last_battery_v", "last_rssi", "engine_on", "engine_changed_at"
FROM "devices" WHERE "organization_id" IS NOT NULL;--> statement-breakpoint
INSERT INTO "device_assignments" ("device_id", "machine_id", "started_at")
SELECT d."id", m."id", d."first_seen_at" FROM "machines" m JOIN "devices" d ON d."id" = m."code";--> statement-breakpoint
UPDATE "telemetry" t SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = t."device_id";--> statement-breakpoint
UPDATE "device_events" e SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = e."device_id";--> statement-breakpoint
UPDATE "engine_sessions" s SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = s."device_id";--> statement-breakpoint
UPDATE "machine_operators" mo SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = mo."device_id";--> statement-breakpoint
UPDATE "checkins" c SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = c."device_id" AND m."organization_id" = c."organization_id";--> statement-breakpoint
UPDATE "pin_failures" p SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = p."device_id";--> statement-breakpoint
UPDATE "alerts" a SET "machine_id" = m."id" FROM "machines" m WHERE m."code" = a."device_id" AND m."organization_id" = a."organization_id";--> statement-breakpoint
-- Engine periods and PIN failures of unclaimed devices (bench tests) don't belong to any machine, nor do
-- check-ins and alerts left from an organization the device has since been moved away from.--> statement-breakpoint
DELETE FROM "alerts" WHERE "machine_id" IS NULL;--> statement-breakpoint
DELETE FROM "checkins" WHERE "machine_id" IS NULL;--> statement-breakpoint
DELETE FROM "engine_sessions" WHERE "machine_id" IS NULL;--> statement-breakpoint
DELETE FROM "pin_failures" WHERE "machine_id" IS NULL;--> statement-breakpoint
DELETE FROM "machine_operators" WHERE "machine_id" IS NULL;
