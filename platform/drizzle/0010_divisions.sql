CREATE TABLE "divisions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_divisions" (
	"user_id" bigint NOT NULL,
	"division_id" bigint NOT NULL,
	CONSTRAINT "user_divisions_user_id_division_id_pk" PRIMARY KEY("user_id","division_id")
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "division_id" bigint;--> statement-breakpoint
ALTER TABLE "divisions" ADD CONSTRAINT "divisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_divisions" ADD CONSTRAINT "user_divisions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_divisions" ADD CONSTRAINT "user_divisions_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "divisions_org_name_idx" ON "divisions" USING btree ("organization_id","name");--> statement-breakpoint
ALTER TABLE "machines" ADD CONSTRAINT "machines_division_id_divisions_id_fk" FOREIGN KEY ("division_id") REFERENCES "public"."divisions"("id") ON DELETE restrict ON UPDATE no action;