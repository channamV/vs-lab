CREATE TABLE "device_diagnostics" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"boot_number" integer,
	"restart_reason" text,
	"lines" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "device_diagnostics" ADD CONSTRAINT "device_diagnostics_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_diagnostics_device_time_idx" ON "device_diagnostics" USING btree ("device_id","received_at");