CREATE TABLE "confluence_space_page_selections" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"cloud_id" text NOT NULL,
	"space_id" text NOT NULL,
	"space_key" text,
	"space_name" text,
	"page_id" text NOT NULL,
	"page_title" text,
	"is_selected" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "confluence_space_page_selections_org_id_space_id_page_id_unique" UNIQUE("org_id","space_id","page_id")
);
--> statement-breakpoint
CREATE TABLE "forge_installations" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"cloud_id" text,
	"installation_context" text,
	"installation_id" text,
	"app_id" text,
	"app_system_token" text,
	"installed_by_user_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_event_payload" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "confluence_space_page_selections_org_id_index" ON "confluence_space_page_selections" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_installations_org_id_uq" ON "forge_installations" ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "forge_installations_cloud_id_uq" ON "forge_installations" ("cloud_id") WHERE "cloud_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "forge_installations_pending_installed_by_user_id_uq" ON "forge_installations" ("installed_by_user_id") WHERE "status" = 'pending' and "installed_by_user_id" is not null;--> statement-breakpoint
CREATE INDEX "forge_installations_cloud_id_idx" ON "forge_installations" ("cloud_id");--> statement-breakpoint
ALTER TABLE "confluence_space_page_selections" ADD CONSTRAINT "confluence_space_page_selections_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forge_installations" ADD CONSTRAINT "forge_installations_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "forge_installations" ADD CONSTRAINT "forge_installations_installed_by_user_id_users_id_fkey" FOREIGN KEY ("installed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL;