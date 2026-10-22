CREATE TABLE "machine_mode_changes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"mode" text NOT NULL,
	"until" timestamp with time zone,
	"reason" text,
	"source" text NOT NULL,
	"changed_by" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode" text DEFAULT 'access_controlled' NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_revert_to" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_reason" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_changed_by" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_source" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "offline_mode" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "offline_after_hours" integer DEFAULT 12 NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "confirmed_mode" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "confirmed_mode_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "lock_anchor_lat" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "lock_anchor_lng" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "lock_movement_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_mode_changes" ADD CONSTRAINT "machine_mode_changes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_mode_changes" ADD CONSTRAINT "machine_mode_changes_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "machine_mode_changes_machine_idx" ON "machine_mode_changes" USING btree ("machine_id","at");--> statement-breakpoint
-- Arm/disarm becomes the operating mode. Armed → Access-Controlled; disarmed until re-armed → Unlocked; disarmed
-- until a time → Unlocked until then. GPS & Telematics machines stay Access-Controlled, which behaves as Unlocked
-- for them (no check-ins), so an upgrade to Safety & Access Monitoring starts Access-Controlled.
UPDATE "machines" SET
  "mode" = CASE
    WHEN "tier" = 'gps' THEN 'access_controlled'
    WHEN "disarmed" AND ("disarmed_until" IS NULL OR "disarmed_until" > now()) THEN 'unlocked'
    ELSE 'access_controlled' END,
  "mode_until" = CASE WHEN "tier" <> 'gps' AND "disarmed" AND "disarmed_until" > now() THEN "disarmed_until" END,
  "mode_revert_to" = CASE WHEN "tier" <> 'gps' AND "disarmed" AND "disarmed_until" > now() THEN 'access_controlled' END,
  "mode_source" = 'manager',
  "mode_changed_at" = now();
--> statement-breakpoint
-- Everyone with the default "All alerts" subscription also hears about locked machines being used or moved.
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'start_while_locked')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('start_while_locked' = ANY("event_types"));
--> statement-breakpoint
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'unauthorized_movement')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('unauthorized_movement' = ANY("event_types"));
