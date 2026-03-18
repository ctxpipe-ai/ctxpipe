CREATE TABLE "connector_spaces" (
	"id" text PRIMARY KEY,
	"connector_id" text NOT NULL,
	"space_key" text NOT NULL,
	"space_name" text,
	"last_synced_page_id" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connector_sync_logs" (
	"id" text PRIMARY KEY,
	"connector_id" text NOT NULL,
	"status" text NOT NULL,
	"pr_number" integer,
	"pr_url" text,
	"pages_added" integer DEFAULT 0,
	"pages_updated" integer DEFAULT 0,
	"pages_deleted" integer DEFAULT 0,
	"error_message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "connectors" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"type" text NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"github_repo_id" text,
	"github_repo_name" text,
	"github_branch" text,
	"last_pr_number" integer,
	"last_sync_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connectors_org_id_type_unique" UNIQUE("org_id","type")
);
--> statement-breakpoint
CREATE INDEX "connector_spaces_connector_id_index" ON "connector_spaces" ("connector_id");--> statement-breakpoint
CREATE INDEX "connector_spaces_connector_id_space_key_index" ON "connector_spaces" ("connector_id","space_key");--> statement-breakpoint
CREATE INDEX "connector_sync_logs_connector_id_started_at_index" ON "connector_sync_logs" ("connector_id","started_at");--> statement-breakpoint
CREATE INDEX "connector_sync_logs_connector_id_status_index" ON "connector_sync_logs" ("connector_id","status");--> statement-breakpoint
CREATE INDEX "connectors_org_id_index" ON "connectors" ("org_id");--> statement-breakpoint
CREATE INDEX "connectors_org_id_enabled_index" ON "connectors" ("org_id","enabled");--> statement-breakpoint
ALTER TABLE "connector_spaces" ADD CONSTRAINT "connector_spaces_connector_id_connectors_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "connector_sync_logs" ADD CONSTRAINT "connector_sync_logs_connector_id_connectors_id_fkey" FOREIGN KEY ("connector_id") REFERENCES "connectors"("id") ON DELETE CASCADE;