ALTER TABLE "machines" ADD COLUMN "battery_low_pending_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "battery_low_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "battery_low_volts" real;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "planned_hours_per_day" real DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "working_days" integer[] DEFAULT '{1,2,3,4,5}' NOT NULL;