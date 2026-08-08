CREATE TABLE "linear_dirty_entities" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"action" text NOT NULL,
	"first_dirty_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "linear_dirty_entities_connection_type_external_id_uq" UNIQUE("connection_id","entity_type","external_id")
);
--> statement-breakpoint
CREATE TABLE "linear_scopes" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"external_id" text NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"url" text,
	"parent_external_id" text,
	"team_id" text,
	"team_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "linear_scopes_connection_type_external_id_uq" UNIQUE("connection_id","type","external_id")
);
--> statement-breakpoint
CREATE TABLE "linear_sync_targets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"setup_phase" text DEFAULT 'draft' NOT NULL,
	"pending_config_pull_url" text,
	"pending_config_pr_creating" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "linear_dirty_entities_connection_id_idx" ON "linear_dirty_entities" ("connection_id");--> statement-breakpoint
CREATE INDEX "linear_dirty_entities_flush_idx" ON "linear_dirty_entities" ("connection_id","last_event_at","first_dirty_at");--> statement-breakpoint
CREATE INDEX "linear_scopes_connection_id_idx" ON "linear_scopes" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "linear_sync_targets_connection_id_uq" ON "linear_sync_targets" ("connection_id");--> statement-breakpoint
CREATE INDEX "linear_sync_targets_repository_id_idx" ON "linear_sync_targets" ("repository_id");--> statement-breakpoint
ALTER TABLE "linear_dirty_entities" ADD CONSTRAINT "linear_dirty_entities_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "linear_scopes" ADD CONSTRAINT "linear_scopes_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "linear_sync_targets" ADD CONSTRAINT "linear_sync_targets_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "linear_sync_targets" ADD CONSTRAINT "linear_sync_targets_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "linear_sync_targets" ADD CONSTRAINT "linear_sync_targets_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT;