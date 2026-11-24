CREATE TABLE "workspace_merge_waiters" (
	"org_id" text,
	"workspace_id" text NOT NULL,
	"run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_merge_waiters_pkey" PRIMARY KEY("org_id","run_id")
);
--> statement-breakpoint
ALTER TABLE "workspace_merge_waiters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE INDEX "workspace_merge_waiters_workspace_idx" ON "workspace_merge_waiters" ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "workspace_merge_waiters" ADD CONSTRAINT "workspace_merge_waiters_org_id_organizations_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "workspace_merge_waiters" AS PERMISSIVE FOR ALL TO public USING ("workspace_merge_waiters"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("workspace_merge_waiters"."org_id" = current_setting('app.organization_id', true));