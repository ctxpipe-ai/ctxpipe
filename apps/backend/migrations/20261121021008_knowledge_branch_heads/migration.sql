CREATE TABLE "knowledge_branch_heads" (
	"workspace_id" text,
	"organization_id" text NOT NULL,
	"branch" text,
	"last_sha" text,
	"merge_base" text,
	"tree_version" bigint DEFAULT 0 NOT NULL,
	"projection_version" text,
	"run_status" text NOT NULL,
	"failed_count" integer DEFAULT 0 NOT NULL,
	"default_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_branch_heads_pkey" PRIMARY KEY("workspace_id","branch")
);
--> statement-breakpoint
ALTER TABLE "knowledge_branch_heads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_branch_heads" ADD CONSTRAINT "knowledge_branch_heads_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "knowledge_branch_heads" AS PERMISSIVE FOR ALL TO public USING ("knowledge_branch_heads"."organization_id" = current_setting('app.organization_id', true)) WITH CHECK ("knowledge_branch_heads"."organization_id" = current_setting('app.organization_id', true));