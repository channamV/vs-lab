CREATE TABLE "alerts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"title" text NOT NULL,
	"detail" text,
	"engine_session_id" bigint,
	"checkin_id" bigint,
	"acknowledged_at" timestamp with time zone,
	"ack_note" text,
	"email_status" text,
	"email_error" text
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "disarmed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "disarmed_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_engine_session_id_engine_sessions_id_fk" FOREIGN KEY ("engine_session_id") REFERENCES "public"."engine_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_checkin_id_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."checkins"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_created_idx" ON "alerts" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "alerts_device_created_idx" ON "alerts" USING btree ("device_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_per_engine_session_idx" ON "alerts" USING btree ("type","engine_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_one_per_checkin_idx" ON "alerts" USING btree ("type","checkin_id");