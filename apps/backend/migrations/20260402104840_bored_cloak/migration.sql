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
CREATE INDEX "confluence_spaces_forge_installation_id_index" ON "confluence_spaces" ("forge_installation_id");--> statement-breakpoint
ALTER TABLE "confluence_spaces" ADD CONSTRAINT "confluence_spaces_GkiKXFO3wg9l_fkey" FOREIGN KEY ("forge_installation_id") REFERENCES "forge_installations"("id") ON DELETE CASCADE;