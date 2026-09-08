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
CREATE UNIQUE INDEX "repository_ingestion_requests_request_id_uidx" ON "repository_ingestion_requests" ("request_id");--> statement-breakpoint
ALTER TABLE "repository_ingestion_requests" ADD CONSTRAINT "repository_ingestion_requests_ZwLAikCC14ZA_fkey" FOREIGN KEY ("repository_id") REFERENCES "repositories"("id") ON DELETE CASCADE;--> statement-breakpoint
CREATE POLICY "org_isolation" ON "repository_ingestion_requests" AS PERMISSIVE FOR ALL TO public USING ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true)) WITH CHECK ("repository_ingestion_requests"."org_id" = current_setting('app.organization_id', true));