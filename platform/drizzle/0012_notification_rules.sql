CREATE TABLE "notification_deliveries" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"event_id" bigint NOT NULL,
	"user_id" bigint,
	"rule_names" text[] NOT NULL,
	"channel" text NOT NULL,
	"recipient" text NOT NULL,
	"status" text NOT NULL,
	"error" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"type" text NOT NULL,
	"operator_id" bigint,
	"engine_session_id" bigint,
	"alert_id" bigint,
	"detail" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "notification_rules" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"name" text NOT NULL,
	"event_types" text[] NOT NULL,
	"machine_ids" bigint[] DEFAULT '{}' NOT NULL,
	"division_ids" bigint[] DEFAULT '{}' NOT NULL,
	"operator_ids" bigint[] DEFAULT '{}' NOT NULL,
	"weekdays" integer[] DEFAULT '{}' NOT NULL,
	"start_time" text DEFAULT '' NOT NULL,
	"end_time" text DEFAULT '' NOT NULL,
	"timezone" text NOT NULL,
	"channels" text[] DEFAULT '{email}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_event_id_notification_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."notification_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_engine_session_id_engine_sessions_id_fk" FOREIGN KEY ("engine_session_id") REFERENCES "public"."engine_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD CONSTRAINT "notification_rules_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_deliveries_once_idx" ON "notification_deliveries" USING btree ("event_id","user_id","channel");--> statement-breakpoint
CREATE INDEX "notification_events_org_time_idx" ON "notification_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "notification_events_pending_idx" ON "notification_events" USING btree ("machine_id") WHERE "notification_events"."processed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_one_per_session_idx" ON "notification_events" USING btree ("type","engine_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_one_per_alert_idx" ON "notification_events" USING btree ("alert_id");--> statement-breakpoint
CREATE INDEX "notification_rules_org_idx" ON "notification_rules" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notification_rules_user_idx" ON "notification_rules" USING btree ("user_id");--> statement-breakpoint
-- Each existing alert subscription becomes a notification rule (same alerts, same machines).
INSERT INTO "notification_rules" ("organization_id", "user_id", "name", "event_types", "machine_ids", "division_ids", "timezone", "channels", "created_at")
SELECT u."organization_id", s."user_id",
  CASE s."type"
    WHEN 'unauthorized-use' THEN 'Start without checklist'
    WHEN 'checklist-failed' THEN 'Checklist repairs'
    WHEN 'not-approved' THEN 'Operator not approved'
    WHEN 'not-at-machine' THEN 'Check-in not at machine'
    ELSE 'All alerts' END,
  CASE s."type"
    WHEN 'unauthorized-use' THEN ARRAY['start_no_checklist']
    WHEN 'checklist-failed' THEN ARRAY['checklist_repair']
    WHEN 'not-approved' THEN ARRAY['operator_not_approved']
    WHEN 'not-at-machine' THEN ARRAY['not_at_machine']
    ELSE ARRAY['start_no_checklist', 'checklist_repair', 'operator_not_approved', 'not_at_machine'] END,
  CASE WHEN s."machine_id" IS NULL THEN '{}'::bigint[] ELSE ARRAY[s."machine_id"] END,
  CASE WHEN s."division_id" IS NULL THEN '{}'::bigint[] ELSE ARRAY[s."division_id"] END,
  'America/Toronto', ARRAY[s."channel"], s."created_at"
FROM "alert_subscriptions" s JOIN "users" u ON u."id" = s."user_id";
