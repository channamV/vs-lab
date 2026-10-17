ALTER TABLE "checkins" ADD COLUMN "engine_session_id" bigint;--> statement-breakpoint
ALTER TABLE "checkins" ADD COLUMN "engine_link" text;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_engine_session_id_engine_sessions_id_fk" FOREIGN KEY ("engine_session_id") REFERENCES "public"."engine_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkins_engine_session_idx" ON "checkins" USING btree ("engine_session_id");