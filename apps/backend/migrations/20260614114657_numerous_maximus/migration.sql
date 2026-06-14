CREATE TABLE "dashboard_metric_snapshots" (
	"org_id" text NOT NULL,
	"metric_date" date NOT NULL,
	"context_confidence" real,
	"active_claims" integer NOT NULL,
	"low_confidence_claims" integer NOT NULL,
	"stale_claims_gt30d" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_metric_snapshots_org_date_uniq" UNIQUE("org_id","metric_date")
);
--> statement-breakpoint
CREATE INDEX "dashboard_metric_snapshots_org_date_idx" ON "dashboard_metric_snapshots" ("org_id","metric_date");