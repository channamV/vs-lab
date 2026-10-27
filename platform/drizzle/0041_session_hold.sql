ALTER TABLE "checkins" ADD COLUMN "hold_minutes" integer;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "resume_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "last_resumed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "session_hold_minutes" integer DEFAULT 90;