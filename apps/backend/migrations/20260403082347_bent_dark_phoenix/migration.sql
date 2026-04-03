CREATE TABLE "confluence_sync_targets" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"forge_installation_id" text NOT NULL,
	"repository_name" text NOT NULL,
	"branch" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "confluence_sync_targets_org_id_uq" ON "confluence_sync_targets" ("org_id");--> statement-breakpoint
CREATE INDEX "confluence_sync_targets_forge_installation_id_idx" ON "confluence_sync_targets" ("forge_installation_id");--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_jHlqwgXotiCq_fkey" FOREIGN KEY ("forge_installation_id") REFERENCES "forge_installations"("id") ON DELETE CASCADE;