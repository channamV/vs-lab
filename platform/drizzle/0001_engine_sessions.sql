CREATE TABLE "engine_sessions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone NOT NULL,
	"source" text
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "engine_on" boolean;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "engine_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "telemetry" ADD COLUMN "engine_on" boolean;--> statement-breakpoint
ALTER TABLE "engine_sessions" ADD CONSTRAINT "engine_sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "engine_sessions_device_start_idx" ON "engine_sessions" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "engine_sessions_one_open_idx" ON "engine_sessions" USING btree ("device_id") WHERE "engine_sessions"."ended_at" is null;