ALTER TABLE "workspaces" ADD COLUMN "desired_default_branch" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "active_revision" jsonb;