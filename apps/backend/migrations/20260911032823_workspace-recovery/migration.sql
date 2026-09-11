CREATE TABLE "repository_ingestion_requests" (
	"repository_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"request_id" text NOT NULL,
	"target_branch" text,
	"indexing_reason" text,
	"repository_url" text NOT NULL,
	"github_connection_id" text,
	"workflow_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repository_ingestion_requests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "sandbox_locks" (
	"org_id" text,
	"key" text,
	"owner" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "sandbox_locks_pkey" PRIMARY KEY("org_id","key")
);
--> statement-breakpoint
ALTER TABLE "sandbox_locks" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_knowledge_path_state" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"revision" jsonb NOT NULL,
	"paths" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP INDEX "workspace_sandbox_instances_live_chat_conversation_uidx";--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "content_sync_generation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "connections" ADD COLUMN "content_sync_workflow_run_id" text;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_chat_pr_revision" jsonb;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "image" text;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "transition_key" text;--> statement-breakpoint
ALTER TABLE "workspace_sandbox_instances" ADD COLUMN "revision" jsonb;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "desired_default_branch" text;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "active_revision" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "repository_ingestion_requests_request_id_uidx" ON "repository_ingestion_requests" ("request_id");--> statement-breakpoint
ALTER TABLE "repository_ingestion_requests" ADD CONSTRAINT "repository_ingestion_requests_ZwLAikCC14ZA_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "sandbox_locks" ADD CONSTRAINT "sandbox_locks_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_knowledge_path_state" ADD CONSTRAINT "workspace_knowledge_path_state_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_ingestion_requests" AS PERMISSIVE FOR ALL TO public USING ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "sandbox_locks" AS PERMISSIVE FOR ALL TO public USING ("sandbox_locks"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("sandbox_locks"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_knowledge_path_state" AS PERMISSIVE FOR ALL TO public USING ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_knowledge_path_state"."org_id" = current_setting('app.organization_id', true));