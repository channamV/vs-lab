CREATE TABLE "checkins" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"operator_id" bigint NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"authorized" boolean NOT NULL,
	"checklist_ok" boolean NOT NULL,
	"answers" jsonb NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "machine_operators" (
	"device_id" text NOT NULL,
	"operator_id" bigint NOT NULL,
	CONSTRAINT "machine_operators_device_id_operator_id_pk" PRIMARY KEY("device_id","operator_id")
);
--> statement-breakpoint
CREATE TABLE "operators" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"pin_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operators_pin_hash_unique" UNIQUE("pin_hash")
);
--> statement-breakpoint
CREATE TABLE "pin_failures" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"device_id" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "checkins" ADD CONSTRAINT "checkins_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_operators" ADD CONSTRAINT "machine_operators_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_operators" ADD CONSTRAINT "machine_operators_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkins_device_start_idx" ON "checkins" USING btree ("device_id","started_at");--> statement-breakpoint
CREATE INDEX "checkins_operator_start_idx" ON "checkins" USING btree ("operator_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_one_open_idx" ON "checkins" USING btree ("device_id") WHERE "checkins"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "pin_failures_device_time_idx" ON "pin_failures" USING btree ("device_id","at");