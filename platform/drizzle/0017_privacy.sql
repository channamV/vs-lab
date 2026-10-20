CREATE TABLE "audit_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" text NOT NULL,
	"staff" boolean DEFAULT false NOT NULL,
	"action" text NOT NULL,
	"detail" text
);
--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "erased_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "privacy_contact" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_phone_location_days" integer DEFAULT 90 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_photo_days" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_telemetry_days" integer DEFAULT 730 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_checkin_days" integer DEFAULT 1095 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_notification_days" integer DEFAULT 365 NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_org_time_idx" ON "audit_log" USING btree ("organization_id","at");