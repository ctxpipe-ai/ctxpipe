ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "provider_sandbox_id" text;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "latest_snapshot_id" text;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "latest_run_id" text;