CREATE TABLE "machine_faults" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"organization_id" bigint NOT NULL,
	"machine_id" bigint NOT NULL,
	"spn" integer NOT NULL,
	"fmi" integer NOT NULL,
	"lamps" integer,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"cleared_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "engine_hour_meter" double precision;--> statement-breakpoint
ALTER TABLE "machines" ADD COLUMN "engine_hour_meter_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "machine_faults" ADD CONSTRAINT "machine_faults_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_faults" ADD CONSTRAINT "machine_faults_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_faults_one_active_idx" ON "machine_faults" USING btree ("machine_id","spn","fmi") WHERE "machine_faults"."cleared_at" is null;--> statement-breakpoint
CREATE INDEX "machine_faults_machine_idx" ON "machine_faults" USING btree ("machine_id","first_seen_at");