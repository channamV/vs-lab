CREATE TABLE "breach_records" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone,
	"discovered_at" timestamp with time zone NOT NULL,
	"description" text NOT NULL,
	"data_involved" text,
	"organizations_affected" text,
	"people_affected" integer,
	"real_risk_of_significant_harm" boolean,
	"risk_reasoning" text,
	"reported_to_commissioner_at" timestamp with time zone,
	"individuals_notified_at" timestamp with time zone,
	"customers_notified_at" timestamp with time zone,
	"actions_taken" text,
	"closed_at" timestamp with time zone,
	"recorded_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
