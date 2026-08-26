CREATE TABLE "workspace_commit_projections" (
	"workspace_id" text PRIMARY KEY,
	"org_id" text NOT NULL,
	"head_sha" text,
	"backfill_status" text DEFAULT 'pending' NOT NULL,
	"backfilled_since" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspace_commit_projections" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "workspace_repository_commits" (
	"org_id" text NOT NULL,
	"workspace_id" text,
	"sha" text,
	"committed_at" timestamp with time zone NOT NULL,
	"author_name" text NOT NULL,
	"subject" text NOT NULL,
	"html_url" text,
	CONSTRAINT "workspace_repository_commits_pkey" PRIMARY KEY("workspace_id","sha")
);
--> statement-breakpoint
ALTER TABLE "workspace_repository_commits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "workspace_commit_projections_org_id_idx" ON "workspace_commit_projections" ("org_id");--> statement-breakpoint
CREATE INDEX "workspace_repository_commits_workspace_committed_at_idx" ON "workspace_repository_commits" ("workspace_id","committed_at");--> statement-breakpoint
CREATE INDEX "workspace_repository_commits_org_id_idx" ON "workspace_repository_commits" ("org_id");--> statement-breakpoint
ALTER TABLE "workspace_commit_projections" ADD CONSTRAINT "workspace_commit_projections_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "workspace_repository_commits" ADD CONSTRAINT "workspace_repository_commits_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_commit_projections" AS PERMISSIVE FOR ALL TO public USING ("workspace_commit_projections"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_commit_projections"."org_id" = current_setting('app.organization_id', true));--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_repository_commits" AS PERMISSIVE FOR ALL TO public USING ("workspace_repository_commits"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_repository_commits"."org_id" = current_setting('app.organization_id', true));