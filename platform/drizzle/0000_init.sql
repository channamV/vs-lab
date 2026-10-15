CREATE TYPE "public"."tier" AS ENUM('gps', 'monitor', 'control');--> statement-breakpoint
CREATE TABLE "device_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"type" text NOT NULL,
	"rssi" integer,
	"detail" text
);
--> statement-breakpoint
CREATE TABLE "devices" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"tier" "tier" DEFAULT 'gps' NOT NULL,
	"vin" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_fix_at" timestamp with time zone,
	"last_lat" double precision,
	"last_lng" double precision,
	"last_speed_kph" real,
	"last_battery_v" real,
	"last_rssi" integer
);
--> statement-breakpoint
CREATE TABLE "telemetry" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"device_ms" bigint,
	"lat" double precision,
	"lng" double precision,
	"altitude_m" real,
	"speed_kph" real,
	"heading" integer,
	"satellites" integer,
	"battery_v" real,
	"rssi" integer,
	"device_temp_c" real,
	"fields" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_events" ADD CONSTRAINT "device_events_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telemetry" ADD CONSTRAINT "telemetry_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_events_device_time_idx" ON "device_events" USING btree ("device_id","at");--> statement-breakpoint
CREATE INDEX "telemetry_device_time_idx" ON "telemetry" USING btree ("device_id","received_at");