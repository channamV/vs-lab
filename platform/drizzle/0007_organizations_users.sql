CREATE TYPE "public"."role" AS ENUM('owner', 'manager', 'viewer');--> statement-breakpoint
CREATE TABLE "login_tokens" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"user_id" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"view_organization_id" bigint
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"role" "role" DEFAULT 'manager' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sign_in_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operators" DROP CONSTRAINT "operators_pin_hash_unique";--> statement-breakpoint
ALTER TABLE "alerts" ADD COLUMN "organization_id" bigint;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "organization_id" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "organization_id" bigint;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "organization_id" bigint;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "employee_number" text;--> statement-breakpoint
-- Existing machines, operators, check-ins and alerts move into the first organization.--> statement-breakpoint
INSERT INTO "organizations" ("name") VALUES ('Veristart Lab');--> statement-breakpoint
UPDATE "devices" SET "organization_id" = (SELECT min("id") FROM "organizations");--> statement-breakpoint
UPDATE "operators" SET "organization_id" = (SELECT min("id") FROM "organizations");--> statement-breakpoint
UPDATE "checkins" SET "organization_id" = (SELECT min("id") FROM "organizations");--> statement-breakpoint
UPDATE "alerts" SET "organization_id" = (SELECT min("id") FROM "organizations");--> statement-breakpoint
ALTER TABLE "operators" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "organization_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_view_organization_id_organizations_id_fk" FOREIGN KEY ("view_organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "login_tokens_hash_idx" ON "login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_tokens_email_idx" ON "login_tokens" USING btree ("email","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_idx" ON "sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "devices" ADD CONSTRAINT "devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operators" ADD CONSTRAINT "operators_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "operators_org_pin_idx" ON "operators" USING btree ("organization_id","pin_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "operators_org_employee_idx" ON "operators" USING btree ("organization_id","employee_number") WHERE "operators"."employee_number" is not null;