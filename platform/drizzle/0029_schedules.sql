CREATE TABLE "schedules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"action" text NOT NULL,
	"mode" text,
	"machine_ids" bigint[] DEFAULT '{}' NOT NULL,
	"operator_ids" bigint[] DEFAULT '{}' NOT NULL,
	"recurrence" text NOT NULL,
	"timezone" text NOT NULL,
	"start_date" text,
	"start_time" text,
	"end_date" text,
	"end_time" text,
	"no_end" boolean DEFAULT false NOT NULL,
	"weekdays" integer[] DEFAULT '{}' NOT NULL,
	"all_day" boolean DEFAULT false NOT NULL,
	"effective_from" text,
	"effective_until" text,
	"end_behavior" text DEFAULT 'revert' NOT NULL,
	"end_mode" text,
	"remind_before_expiry" boolean DEFAULT false NOT NULL,
	"reminder_sent_for" timestamp with time zone,
	"created_by_user_id" bigint,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machine_mode_changes" ADD COLUMN "schedule_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "schedule_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "mode_before_schedule" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "manual_mode_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "schedule_late_alerted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "timezone" text DEFAULT 'America/Toronto' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "schedule_conflict_rule" text DEFAULT 'least_restrictive' NOT NULL;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "schedules_org_idx" ON "schedules" USING btree ("organization_id");--> statement-breakpoint
-- Everyone with the default "All alerts" subscription also hears when a scheduled change is late.
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'schedule_change_late')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('schedule_change_late' = ANY("event_types"));
