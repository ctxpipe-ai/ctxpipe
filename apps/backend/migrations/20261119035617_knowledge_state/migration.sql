CREATE TABLE "knowledge_state" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"last_sha" text,
	"attempt_shas" text[] DEFAULT '{}'::text[] NOT NULL,
	"projection_version" text,
	"run_status" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_state" ADD CONSTRAINT "knowledge_state_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "knowledge_state" AS PERMISSIVE FOR ALL TO public USING ("knowledge_state"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("knowledge_state"."org_id" = current_setting('app.organization_id', true));