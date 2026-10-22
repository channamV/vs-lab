CREATE TABLE "firmware_releases" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"version" text NOT NULL,
	"notes" text,
	"file_name" text NOT NULL,
	"storage_key" text NOT NULL,
	"sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"uploaded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "firmware_releases_version_unique" UNIQUE("version")
);
--> statement-breakpoint
ALTER TABLE "device_commands" ADD COLUMN "firmware_release_id" bigint;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_version" text;--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "firmware_reported_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "speed_limit_kph" real;--> statement-breakpoint
ALTER TABLE "device_commands" ADD CONSTRAINT "device_commands_firmware_release_id_firmware_releases_id_fk" FOREIGN KEY ("firmware_release_id") REFERENCES "public"."firmware_releases"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "device_commands_release_idx" ON "device_commands" USING btree ("firmware_release_id");