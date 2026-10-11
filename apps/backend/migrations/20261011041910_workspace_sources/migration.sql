CREATE TABLE "workspace_sources" (
	"id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"source_key" text NOT NULL,
	"connection_id" text,
	"provider" text,
	"scope" jsonb DEFAULT '{}' NOT NULL,
	"status" text NOT NULL,
	"status_detail" text,
	"revision" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_sources_workspace_id_source_key_uidx" UNIQUE("workspace_id","source_key")
);
--> statement-breakpoint
ALTER TABLE "workspace_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "workspace_sources_connection_id_idx" ON "workspace_sources" ("connection_id");--> statement-breakpoint
CREATE INDEX "workspace_sources_org_id_idx" ON "workspace_sources" ("org_id");--> statement-breakpoint
ALTER TABLE "workspace_sources" ADD CONSTRAINT "workspace_sources_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_sources" AS PERMISSIVE FOR ALL TO public USING ("workspace_sources"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_sources"."org_id" = current_setting('app.organization_id', true));