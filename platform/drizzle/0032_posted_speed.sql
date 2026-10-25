CREATE TABLE "road_coverage" (
	"organization_id" bigint NOT NULL,
	"month" text NOT NULL,
	"known_km" double precision DEFAULT 0 NOT NULL,
	"unknown_km" double precision DEFAULT 0 NOT NULL,
	"off_road_km" double precision DEFAULT 0 NOT NULL,
	CONSTRAINT "road_coverage_organization_id_month_pk" PRIMARY KEY("organization_id","month")
);
--> statement-breakpoint
CREATE TABLE "road_tiles" (
	"key" text PRIMARY KEY NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"roads" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "on_road" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "road_checked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "posted_limit_tolerance_pct" integer;--> statement-breakpoint
ALTER TABLE "road_coverage" ADD CONSTRAINT "road_coverage_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Existing pickups and on-road dump trucks (by training category) are on-road vehicles.
UPDATE "machines" SET "on_road" = true WHERE "category_id" IN (SELECT "id" FROM "machine_categories" WHERE "name" IN ('Pickup / light vehicle', 'Dump truck (on-road)'));
