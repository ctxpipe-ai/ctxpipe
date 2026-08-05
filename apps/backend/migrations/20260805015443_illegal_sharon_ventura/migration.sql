CREATE TABLE "slack_channels" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"name" text NOT NULL,
	"is_private" boolean DEFAULT false NOT NULL,
	"last_synced_at" timestamp with time zone,
	"backfill_cursor" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_channels_connection_channel_id_uq" UNIQUE("connection_id","channel_id")
);
--> statement-breakpoint
CREATE TABLE "slack_dirty_threads" (
	"id" text PRIMARY KEY,
	"connection_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"thread_ts" text NOT NULL,
	"first_dirty_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_event_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "slack_dirty_threads_connection_channel_thread_uq" UNIQUE("connection_id","channel_id","thread_ts")
);
--> statement-breakpoint
CREATE TABLE "slack_sync_targets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"connection_id" text NOT NULL,
	"repository_id" text NOT NULL,
	"branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"setup_phase" text DEFAULT 'draft' NOT NULL,
	"pending_config_pull_url" text,
	"pending_config_pr_creating" boolean DEFAULT false NOT NULL,
	"oldest_days" integer DEFAULT 90 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "slack_channels_connection_id_idx" ON "slack_channels" ("connection_id");--> statement-breakpoint
CREATE INDEX "slack_dirty_threads_connection_id_idx" ON "slack_dirty_threads" ("connection_id");--> statement-breakpoint
CREATE INDEX "slack_dirty_threads_flush_idx" ON "slack_dirty_threads" ("connection_id","last_event_at","first_dirty_at");--> statement-breakpoint
CREATE UNIQUE INDEX "slack_sync_targets_connection_id_uq" ON "slack_sync_targets" ("connection_id");--> statement-breakpoint
CREATE INDEX "slack_sync_targets_repository_id_idx" ON "slack_sync_targets" ("repository_id");--> statement-breakpoint
ALTER TABLE "slack_channels" ADD CONSTRAINT "slack_channels_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slack_dirty_threads" ADD CONSTRAINT "slack_dirty_threads_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slack_sync_targets" ADD CONSTRAINT "slack_sync_targets_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slack_sync_targets" ADD CONSTRAINT "slack_sync_targets_connection_id_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "slack_sync_targets" ADD CONSTRAINT "slack_sync_targets_repository_id_repositories_id_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE RESTRICT;