ALTER TABLE "checkins" ADD COLUMN "relay_allowed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "access_list_hash" text;--> statement-breakpoint
ALTER TABLE "operators" ADD COLUMN "beacon_name" text;--> statement-breakpoint
CREATE UNIQUE INDEX "operators_org_beacon_idx" ON "operators" USING btree ("organization_id","beacon_name") WHERE "operators"."beacon_name" is not null;