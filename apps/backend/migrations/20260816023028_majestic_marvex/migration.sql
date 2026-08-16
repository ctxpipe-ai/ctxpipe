ALTER TABLE "workspaces" ADD COLUMN "desired_generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "desired_sha" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "active_projection_url" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "active_projection_sha" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "indexed_sha" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "write_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "hydrate_status" text DEFAULT 'pending' NOT NULL;