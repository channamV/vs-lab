CREATE TABLE "safety_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint,
	"operator_id" bigint,
	"worksite_id" bigint,
	"kind" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"peak" real,
	"limit_value" real,
	"detail" text,
	"notified_at" timestamp with time zone,
	"dedupe_key" text
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "worksite_visit_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "speeding_event_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "idle_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "idle_event_id" bigint;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "speed_limit_kph" real;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "idle_alert_minutes" integer DEFAULT 30;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "fatigue_daily_hours" real DEFAULT 12;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "fatigue_continuous_hours" real DEFAULT 5;--> statement-breakpoint
ALTER TABLE "worksites" ADD COLUMN "speed_limit_kph" real;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "safety_events" ADD CONSTRAINT "safety_events_worksite_id_worksites_id_fk" FOREIGN KEY ("worksite_id") REFERENCES "public"."worksites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "safety_events_org_time_idx" ON "safety_events" USING btree ("organization_id","started_at");--> statement-breakpoint
CREATE INDEX "safety_events_machine_idx" ON "safety_events" USING btree ("machine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "safety_events_dedupe_idx" ON "safety_events" USING btree ("dedupe_key");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_per_visit_idx" ON "alerts" USING btree ("type","worksite_visit_id");--> statement-breakpoint
-- Everyone with the default "All alerts" subscription also hears about restricted-area entries.
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'restricted_area')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('restricted_area' = ANY("event_types"));
