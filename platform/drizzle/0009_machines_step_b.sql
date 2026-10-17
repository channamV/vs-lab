ALTER TABLE "alerts" DROP CONSTRAINT "alerts_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "checkins" DROP CONSTRAINT "checkins_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "engine_sessions" DROP CONSTRAINT "engine_sessions_device_id_devices_id_fk";
--> statement-breakpoint
ALTER TABLE "machine_operators" DROP CONSTRAINT "machine_operators_device_id_devices_id_fk";
--> statement-breakpoint
DROP INDEX "alerts_device_created_idx";--> statement-breakpoint
DROP INDEX "checkins_device_start_idx";--> statement-breakpoint
DROP INDEX "checkins_one_open_idx";--> statement-breakpoint
DROP INDEX "engine_sessions_device_start_idx";--> statement-breakpoint
DROP INDEX "engine_sessions_one_open_idx";--> statement-breakpoint
DROP INDEX "pin_failures_device_time_idx";--> statement-breakpoint
ALTER TABLE "machine_operators" DROP CONSTRAINT "machine_operators_device_id_operator_id_pk";--> statement-breakpoint
ALTER TABLE "alerts" ALTER COLUMN "machine_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "checkins" ALTER COLUMN "machine_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "engine_sessions" ALTER COLUMN "machine_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_operators" ALTER COLUMN "machine_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "pin_failures" ALTER COLUMN "machine_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_operators" ADD CONSTRAINT "machine_operators_machine_id_operator_id_pk" PRIMARY KEY("machine_id","operator_id");--> statement-breakpoint
CREATE INDEX "alerts_machine_created_idx" ON "alerts" USING btree ("machine_id","created_at");--> statement-breakpoint
CREATE INDEX "checkins_machine_start_idx" ON "checkins" USING btree ("machine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "checkins_one_open_machine_idx" ON "checkins" USING btree ("machine_id") WHERE "checkins"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "engine_sessions_machine_start_idx" ON "engine_sessions" USING btree ("machine_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "engine_sessions_one_open_machine_idx" ON "engine_sessions" USING btree ("machine_id") WHERE "engine_sessions"."ended_at" is null;--> statement-breakpoint
CREATE INDEX "pin_failures_machine_time_idx" ON "pin_failures" USING btree ("machine_id","at");--> statement-breakpoint
ALTER TABLE "alerts" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "checkins" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "name";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "tier";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "disarmed";--> statement-breakpoint
ALTER TABLE "devices" DROP COLUMN "disarmed_until";--> statement-breakpoint
ALTER TABLE "engine_sessions" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "machine_operators" DROP COLUMN "device_id";--> statement-breakpoint
ALTER TABLE "pin_failures" DROP COLUMN "device_id";