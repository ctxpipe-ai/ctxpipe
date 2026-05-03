-- setup_phase values include draft | awaiting_merge | initial_sync | live (application-defined strings).
ALTER TABLE "confluence_sync_targets" ADD COLUMN "setup_phase" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD COLUMN "pending_config_pull_url" text;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD COLUMN "pending_config_pr_creating" boolean DEFAULT false NOT NULL;