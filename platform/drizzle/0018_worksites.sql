CREATE TABLE "worksite_visits" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"worksite_id" bigint NOT NULL,
	"entered_at" timestamp with time zone NOT NULL,
	"last_inside_at" timestamp with time zone NOT NULL,
	"left_at" timestamp with time zone,
	"dwell_notified_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "worksites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"notes" text,
	"polygon" jsonb NOT NULL,
	"center_lat" double precision NOT NULL,
	"center_lng" double precision NOT NULL,
	"dwell_limit_minutes" integer,
	"created_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "worksite_id" bigint;--> statement-breakpoint
ALTER TABLE "notification_events" ADD COLUMN "worksite_visit_id" bigint;--> statement-breakpoint
ALTER TABLE "notification_rules" ADD COLUMN "worksite_ids" bigint[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "worksite_visits" ADD CONSTRAINT "worksite_visits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksite_visits" ADD CONSTRAINT "worksite_visits_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksite_visits" ADD CONSTRAINT "worksite_visits_worksite_id_worksites_id_fk" FOREIGN KEY ("worksite_id") REFERENCES "public"."worksites"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksites" ADD CONSTRAINT "worksites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worksites" ADD CONSTRAINT "worksites_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "worksite_visits_one_open_idx" ON "worksite_visits" USING btree ("machine_id","worksite_id") WHERE "worksite_visits"."left_at" is null;--> statement-breakpoint
CREATE INDEX "worksite_visits_machine_idx" ON "worksite_visits" USING btree ("machine_id","entered_at");--> statement-breakpoint
CREATE INDEX "worksite_visits_site_idx" ON "worksite_visits" USING btree ("worksite_id","entered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "worksites_org_name_idx" ON "worksites" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_worksite_id_worksites_id_fk" FOREIGN KEY ("worksite_id") REFERENCES "public"."worksites"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_worksite_visit_id_worksite_visits_id_fk" FOREIGN KEY ("worksite_visit_id") REFERENCES "public"."worksite_visits"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_events_one_per_visit_idx" ON "notification_events" USING btree ("type","worksite_visit_id");