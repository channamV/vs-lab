CREATE TABLE "fuel_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"engine_session_id" bigint,
	"kind" text NOT NULL,
	"when" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"from_pct" real NOT NULL,
	"to_pct" real NOT NULL,
	"litres" real,
	"alert_id" bigint
);
--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "fuel_anchor_pct" real;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "fuel_anchor_total_l" double precision;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "fuel_anchor_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "fuel_run_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "fuel_events" ADD CONSTRAINT "fuel_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_events" ADD CONSTRAINT "fuel_events_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_events" ADD CONSTRAINT "fuel_events_engine_session_id_engine_sessions_id_fk" FOREIGN KEY ("engine_session_id") REFERENCES "public"."engine_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fuel_events" ADD CONSTRAINT "fuel_events_alert_id_alerts_id_fk" FOREIGN KEY ("alert_id") REFERENCES "public"."alerts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "fuel_events_machine_idx" ON "fuel_events" USING btree ("machine_id","at");--> statement-breakpoint
CREATE INDEX "fuel_events_org_idx" ON "fuel_events" USING btree ("organization_id","at");