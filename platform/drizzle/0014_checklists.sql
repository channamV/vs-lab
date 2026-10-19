CREATE TABLE "checklist_answer_sets" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"options" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "checklist_issues" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"question_id" text NOT NULL,
	"question" text NOT NULL,
	"section" text,
	"severity" text NOT NULL,
	"answer_label" text NOT NULL,
	"note" text,
	"report_count" integer DEFAULT 1 NOT NULL,
	"first_reported_at" timestamp with time zone NOT NULL,
	"last_reported_at" timestamp with time zone NOT NULL,
	"first_checkin_id" bigint,
	"last_checkin_id" bigint,
	"alert_checkin_id" bigint,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" bigint,
	"resolution_note" text
);
--> statement-breakpoint
CREATE TABLE "checklist_templates" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"answer_set_id" bigint NOT NULL,
	"sections" jsonb NOT NULL,
	"confirmation_text" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "template_name" text;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "confirmation_text" text;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "lockout_requested" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "checklist_template_id" bigint;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "locked_out_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "locked_out_reason" text;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "locked_out_checkin_id" bigint;--> statement-breakpoint
ALTER TABLE "checklist_answer_sets" ADD CONSTRAINT "checklist_answer_sets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_first_checkin_id_checkins_id_fk" FOREIGN KEY ("first_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_last_checkin_id_checkins_id_fk" FOREIGN KEY ("last_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_alert_checkin_id_checkins_id_fk" FOREIGN KEY ("alert_checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_issues" ADD CONSTRAINT "checklist_issues_resolved_by_user_id_users_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD CONSTRAINT "checklist_templates_answer_set_id_checklist_answer_sets_id_fk" FOREIGN KEY ("answer_set_id") REFERENCES "public"."checklist_answer_sets"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_answer_sets_org_name_idx" ON "checklist_answer_sets" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_issues_one_open_idx" ON "checklist_issues" USING btree ("machine_id","question_id") WHERE "checklist_issues"."resolved_at" is null;--> statement-breakpoint
CREATE INDEX "checklist_issues_machine_idx" ON "checklist_issues" USING btree ("machine_id","last_reported_at");--> statement-breakpoint
CREATE INDEX "checklist_issues_alert_checkin_idx" ON "checklist_issues" USING btree ("alert_checkin_id");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_org_name_idx" ON "checklist_templates" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "checklist_templates_one_default_idx" ON "checklist_templates" USING btree ("organization_id") WHERE "checklist_templates"."is_default";--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_checklist_template_id_checklist_templates_id_fk" FOREIGN KEY ("checklist_template_id") REFERENCES "public"."checklist_templates"("id") ON DELETE set null ON UPDATE no action;