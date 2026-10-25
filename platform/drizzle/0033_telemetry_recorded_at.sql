ALTER TABLE "telemetry" ADD COLUMN "recorded_at" timestamp with time zone;--> statement-breakpoint
UPDATE "telemetry" SET "recorded_at" = "received_at";--> statement-breakpoint
ALTER TABLE "telemetry" ALTER COLUMN "recorded_at" SET DEFAULT now();--> statement-breakpoint
ALTER TABLE "telemetry" ALTER COLUMN "recorded_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "telemetry_machine_recorded_idx" ON "telemetry" USING btree ("machine_id","recorded_at");
