CREATE TABLE "operator_app_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"operator_id" bigint NOT NULL,
	"token_hash" text NOT NULL,
	"device_name" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "operator_app_sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "operator_login_codes" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "operator_app_sessions" ADD CONSTRAINT "operator_app_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operator_app_sessions" ADD CONSTRAINT "operator_app_sessions_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operator_app_sessions_operator_idx" ON "operator_app_sessions" USING btree ("operator_id");--> statement-breakpoint
CREATE INDEX "operator_login_codes_email_idx" ON "operator_login_codes" USING btree ("email","created_at");