CREATE TABLE "device_incidents" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"device_id" text NOT NULL,
	"kind" text NOT NULL,
	"concern" text NOT NULL,
	"reasons" text[] NOT NULL,
	"last_contact_at" timestamp with time zone NOT NULL,
	"last_rssi" integer,
	"last_battery_v" real,
	"engine_was_on" boolean,
	"signed_off" boolean DEFAULT false NOT NULL,
	"last_lat" double precision,
	"last_lng" double precision,
	"opened_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolution" text,
	"alerted_concern" text,
	"offline_notified" boolean DEFAULT false NOT NULL,
	"online_notified" boolean DEFAULT false NOT NULL,
	"movement_checked" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "incident_id" bigint;--> statement-breakpoint
ALTER TABLE "device_incidents" ADD CONSTRAINT "device_incidents_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_incidents" ADD CONSTRAINT "device_incidents_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_incidents" ADD CONSTRAINT "device_incidents_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "device_incidents_one_open_silent_idx" ON "device_incidents" USING btree ("machine_id") WHERE "device_incidents"."kind" = 'silent' and "device_incidents"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "device_incidents_machine_idx" ON "device_incidents" USING btree ("machine_id","opened_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_per_incident_idx" ON "alerts" USING btree ("type","incident_id");--> statement-breakpoint
-- Everyone with the default "All alerts" subscription also hears about possible tampering.
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'possible_tamper')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('possible_tamper' = ANY("event_types"));
