CREATE TABLE "confluence_spaces" (
	"id" text PRIMARY KEY,
	"forge_installation_id" text NOT NULL,
	"space_key" text NOT NULL,
	"space_name" text,
	"selected_page_ids" jsonb,
	"last_synced_page_id" text,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confluence_spaces_forge_installation_space_key_uq" UNIQUE("forge_installation_id","space_key")
);
--> statement-breakpoint
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
DROP TABLE IF EXISTS "confluence_space_page_selections";--> statement-breakpoint
CREATE INDEX "confluence_spaces_forge_installation_id_index" ON "confluence_spaces" ("forge_installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "confluence_sync_targets_org_id_uq" ON "confluence_sync_targets" ("org_id");--> statement-breakpoint
CREATE INDEX "confluence_sync_targets_forge_installation_id_idx" ON "confluence_sync_targets" ("forge_installation_id");--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_GkiKXFO3wg9l_fkey" FOREIGN KEY ("forge_installation_id") REFERENCES "forge_installations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "confluence_sync_targets" ADD CONSTRAINT "confluence_sync_targets_jHlqwgXotiCq_fkey" FOREIGN KEY ("forge_installation_id") REFERENCES "forge_installations"("id") ON DELETE CASCADE;