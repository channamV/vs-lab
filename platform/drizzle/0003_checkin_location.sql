ALTER TABLE "checkins" ADD COLUMN "phone_lat" double precision;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "phone_lng" double precision;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "phone_accuracy_m" real;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "distance_m" real;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "location_check" text;