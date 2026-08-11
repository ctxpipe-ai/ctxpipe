DROP TABLE "slack_channels";--> statement-breakpoint
DROP TABLE "slack_dirty_threads";--> statement-breakpoint
ALTER TABLE "slack_sync_targets" DROP COLUMN "pending_config_pull_url";--> statement-breakpoint
ALTER TABLE "slack_sync_targets" DROP COLUMN "pending_config_pr_creating";--> statement-breakpoint
ALTER TABLE "slack_sync_targets" DROP COLUMN "oldest_days";