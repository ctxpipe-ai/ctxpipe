CREATE TABLE "workspace_knowledge_path_state" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"revision" jsonb NOT NULL,
	"paths" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN "completed_knowledge_paths";--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ADD CONSTRAINT "workspace_knowledge_path_state_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_path_state" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true));