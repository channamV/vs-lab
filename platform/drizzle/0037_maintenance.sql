CREATE TABLE "maintenance_activity" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" bigint NOT NULL,
	"user_id" bigint,
	"at" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"detail" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_attachments" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"issue_id" bigint NOT NULL,
	"section" text NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"uploaded_by_user_id" bigint,
	"uploaded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"number" integer NOT NULL,
	"source" text NOT NULL,
	"priority" text NOT NULL,
	"status" text DEFAULT 'new' NOT NULL,
	"title" text NOT NULL,
	"complaint" text DEFAULT '' NOT NULL,
	"cause" text,
	"correction" text,
	"performed_by" text,
	"vendor_name" text,
	"dedupe_key" text,
	"question_id" text,
	"section" text,
	"severity" text,
	"answer_label" text,
	"note" text,
	"report_count" integer DEFAULT 1 NOT NULL,
	"first_reported_at" timestamp with time zone NOT NULL,
	"last_reported_at" timestamp with time zone NOT NULL,
	"first_checkin_id" bigint,
	"last_checkin_id" bigint,
	"alert_checkin_id" bigint,
	"schedule_id" bigint,
	"serviced_hours" double precision,
	"serviced_km" double precision,
	"serviced_on" text,
	"lat" double precision,
	"lng" double precision,
	"worksite_id" bigint,
	"created_by_user_id" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" bigint
);
--> statement-breakpoint
CREATE TABLE "maintenance_reports" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"issue_id" bigint NOT NULL,
	"checkin_id" bigint,
	"reported_at" timestamp with time zone NOT NULL,
	"answer_label" text NOT NULL,
	"severity" text NOT NULL,
	"note" text
);
--> statement-breakpoint
CREATE TABLE "maintenance_schedules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"description" text NOT NULL,
	"every_days" integer,
	"every_hours" double precision,
	"every_km" double precision,
	"next_due_on" text,
	"next_due_hours" double precision,
	"next_due_km" double precision,
	"last_serviced_at" timestamp with time zone,
	"active" boolean DEFAULT true NOT NULL,
	"created_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "meter_readings" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"kind" text NOT NULL,
	"value" double precision NOT NULL,
	"source" text NOT NULL,
	"checkin_id" bigint,
	"user_id" bigint,
	"recorded_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "place_names" (
	"key" text PRIMARY KEY NOT NULL,
	"name" text,
	"fetched_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "meter_kind" text;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "meter_reading" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "odometer_km" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "odometer_km_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "maintenance_activity" ADD CONSTRAINT "maintenance_activity_issue_id_maintenance_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."maintenance_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_activity" ADD CONSTRAINT "maintenance_activity_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_issue_id_maintenance_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."maintenance_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_attachments" ADD CONSTRAINT "maintenance_attachments_uploaded_by_user_id_users_id_fk" FOREIGN KEY ("uploaded_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_first_checkin_id_checkins_id_fk" FOREIGN KEY ("first_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_last_checkin_id_checkins_id_fk" FOREIGN KEY ("last_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_alert_checkin_id_checkins_id_fk" FOREIGN KEY ("alert_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_schedule_id_maintenance_schedules_id_fk" FOREIGN KEY ("schedule_id") REFERENCES "public"."maintenance_schedules"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_worksite_id_worksites_id_fk" FOREIGN KEY ("worksite_id") REFERENCES "public"."worksites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_issues" ADD CONSTRAINT "maintenance_issues_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_reports" ADD CONSTRAINT "maintenance_reports_issue_id_maintenance_issues_id_fk" FOREIGN KEY ("issue_id") REFERENCES "public"."maintenance_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_reports" ADD CONSTRAINT "maintenance_reports_checkin_id_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "maintenance_schedules" ADD CONSTRAINT "maintenance_schedules_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_checkin_id_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "meter_readings" ADD CONSTRAINT "meter_readings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "maintenance_activity_issue_idx" ON "maintenance_activity" USING btree ("issue_id","at");--> statement-breakpoint
CREATE INDEX "maintenance_attachments_issue_idx" ON "maintenance_attachments" USING btree ("issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_issues_number_idx" ON "maintenance_issues" USING btree ("organization_id","number");--> statement-breakpoint
CREATE UNIQUE INDEX "maintenance_issues_one_open_idx" ON "maintenance_issues" USING btree ("machine_id","dedupe_key") WHERE "maintenance_issues"."resolved_at" is null and "maintenance_issues"."dedupe_key" is not null;--> statement-breakpoint
CREATE INDEX "maintenance_issues_org_idx" ON "maintenance_issues" USING btree ("organization_id","resolved_at");--> statement-breakpoint
CREATE INDEX "maintenance_issues_machine_idx" ON "maintenance_issues" USING btree ("machine_id","last_reported_at");--> statement-breakpoint
CREATE INDEX "maintenance_issues_alert_checkin_idx" ON "maintenance_issues" USING btree ("alert_checkin_id");--> statement-breakpoint
CREATE INDEX "maintenance_reports_issue_idx" ON "maintenance_reports" USING btree ("issue_id","reported_at");--> statement-breakpoint
CREATE INDEX "maintenance_reports_checkin_idx" ON "maintenance_reports" USING btree ("checkin_id");--> statement-breakpoint
CREATE INDEX "maintenance_schedules_machine_idx" ON "maintenance_schedules" USING btree ("machine_id");--> statement-breakpoint
CREATE INDEX "meter_readings_machine_idx" ON "meter_readings" USING btree ("machine_id","kind","recorded_at");--> statement-breakpoint
-- Checklist issues become maintenance items (same ids), numbered #1001… per organization.
INSERT INTO "maintenance_issues" ("id", "organization_id", "machine_id", "number", "source", "priority", "status", "title", "complaint", "correction", "dedupe_key", "question_id", "section", "severity", "answer_label", "note", "report_count", "first_reported_at", "last_reported_at", "first_checkin_id", "last_checkin_id", "alert_checkin_id", "updated_at", "resolved_at", "resolved_by_user_id")
SELECT i."id", i."organization_id", i."machine_id",
  1000 + row_number() OVER (PARTITION BY i."organization_id" ORDER BY i."first_reported_at", i."id"),
  'checklist', i."severity", CASE WHEN i."resolved_at" IS NULL THEN 'new' ELSE 'resolved' END,
  i."question",
  i."answer_label" || COALESCE(': ' || i."note", '') || CASE WHEN i."report_count" > 1 THEN ' (reported ' || i."report_count" || ' times)' ELSE '' END,
  i."resolution_note", 'checklist:' || i."question_id", i."question_id", i."section", i."severity", i."answer_label", i."note",
  i."report_count", i."first_reported_at", i."last_reported_at", i."first_checkin_id", i."last_checkin_id", i."alert_checkin_id",
  COALESCE(i."resolved_at", i."last_reported_at"), i."resolved_at", i."resolved_by_user_id"
FROM "checklist_issues" i;--> statement-breakpoint
SELECT setval(pg_get_serial_sequence('maintenance_issues', 'id'), GREATEST((SELECT COALESCE(MAX("id"), 0) FROM "maintenance_issues"), 1));--> statement-breakpoint
INSERT INTO "maintenance_reports" ("issue_id", "checkin_id", "reported_at", "answer_label", "severity", "note")
SELECT i."id", i."first_checkin_id", i."first_reported_at", i."answer_label", i."severity", i."note" FROM "checklist_issues" i
UNION ALL
SELECT i."id", i."last_checkin_id", i."last_reported_at", i."answer_label", i."severity", i."note" FROM "checklist_issues" i
WHERE i."last_checkin_id" IS DISTINCT FROM i."first_checkin_id";
