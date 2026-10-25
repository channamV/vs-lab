ALTER TABLE "checkins" ADD COLUMN "checklist_from_checkin_id" bigint;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN "frequency" text DEFAULT 'every_checkin' NOT NULL;