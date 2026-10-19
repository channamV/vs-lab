CREATE TABLE "checkin_photos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"checkin_id" bigint NOT NULL,
	"question_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"content_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"analysis" jsonb
);
--> statement-breakpoint
ALTER TABLE "checkin_photos" ADD CONSTRAINT "checkin_photos_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_photos" ADD CONSTRAINT "checkin_photos_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkin_photos" ADD CONSTRAINT "checkin_photos_checkin_id_checkins_id_fk" FOREIGN KEY ("checkin_id") REFERENCES "public"."checkins"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkin_photos_checkin_idx" ON "checkin_photos" USING btree ("checkin_id");--> statement-breakpoint
CREATE INDEX "checkin_photos_machine_question_idx" ON "checkin_photos" USING btree ("machine_id","question_id");