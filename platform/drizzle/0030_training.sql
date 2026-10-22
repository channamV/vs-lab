CREATE TABLE "certification_types" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"validity_months" integer,
	"category_ids" bigint[] DEFAULT '{}' NOT NULL,
	"machine_ids" bigint[] DEFAULT '{}' NOT NULL,
	"auto_grant" boolean DEFAULT false NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"grace_days" integer DEFAULT 0 NOT NULL,
	"reminder_days" integer[] DEFAULT '{60,30,7}' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_categories" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "training_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"operator_id" bigint NOT NULL,
	"certification_type_id" bigint NOT NULL,
	"issued_on" text NOT NULL,
	"expires_on" text,
	"provider" text,
	"certificate_number" text,
	"notes" text,
	"document_key" text,
	"document_type" text,
	"entered_by" text NOT NULL,
	"entered_by_user_id" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reminded_days" integer,
	"expired_notified_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notification_events" ALTER COLUMN "machine_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "category_id" bigint;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "retain_scan_images" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "certification_types" ADD CONSTRAINT "certification_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_categories" ADD CONSTRAINT "machine_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_certification_type_id_certification_types_id_fk" FOREIGN KEY ("certification_type_id") REFERENCES "public"."certification_types"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "training_records" ADD CONSTRAINT "training_records_entered_by_user_id_users_id_fk" FOREIGN KEY ("entered_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "certification_types_org_name_idx" ON "certification_types" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "machine_categories_org_name_idx" ON "machine_categories" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "training_records_operator_idx" ON "training_records" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "training_records_org_expiry_idx" ON "training_records" USING btree ("organization_id","expires_on");