CREATE TABLE "org_first_workspaces" (
	"org_id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"source_repository_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "org_first_workspaces" ADD CONSTRAINT "org_first_workspaces_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "org_first_workspaces" AS PERMISSIVE FOR ALL TO public USING ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("org_first_workspaces"."org_id" = current_setting('app.organization_id', true));