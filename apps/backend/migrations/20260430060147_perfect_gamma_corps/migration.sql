CREATE TABLE "notion_resources" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"parent_external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_synced_at" timestamp with time zone,
	CONSTRAINT "notion_resources_connection_external_id_uq" UNIQUE("connection_id","external_id")
);
--> statement-breakpoint
CREATE TABLE "notion_sync_targets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"setup_phase" text DEFAULT 'live' NOT NULL,
	"pending_config_pull_url" text,
	"pending_config_pr_creating" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "notion_resources_connection_id_idx" ON "notion_resources" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "notion_sync_targets_connection_id_uq" ON "notion_sync_targets" ("connection_id");--> statement-breakpoint
CREATE INDEX "notion_sync_targets_repository_id_idx" ON "notion_sync_targets" ("repository_id");--> statement-breakpoint
ALTER TABLE "notion_resources" ADD CONSTRAINT "notion_resources_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notion_sync_targets" ADD CONSTRAINT "notion_sync_targets_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notion_sync_targets" ADD CONSTRAINT "notion_sync_targets_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "notion_sync_targets" ADD CONSTRAINT "notion_sync_targets_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT;