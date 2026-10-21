ALTER TABLE "engine_sessions" ADD COLUMN "fuel_start_pct" real;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD COLUMN "fuel_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "fuel_tank_litres" real;--> statement-breakpoint
-- Everyone with the default "All alerts" subscription also hears about possible fuel theft.
UPDATE "notification_rules" SET "event_types" = array_append("event_types", 'possible_fuel_theft')
WHERE "name" = 'All alerts' AND 'start_no_checklist' = ANY("event_types") AND NOT ('possible_fuel_theft' = ANY("event_types"));
