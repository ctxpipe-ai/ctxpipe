ALTER TABLE "workspace_linked_repositories" ADD COLUMN "desired_ref" text;--> statement-breakpoint
ALTER TABLE "workspace_linked_repositories" ADD COLUMN "desired_sha" text;--> statement-breakpoint
ALTER TABLE "workspace_linked_repositories" ADD COLUMN "indexed_sha" text;