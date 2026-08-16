CREATE TABLE "workspace_write_jobs" (
	"id" text PRIMARY KEY,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"commit_sha" text,
	"generation" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "last_chat_pr_number" integer;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "last_job_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_idx" ON "workspace_write_jobs" ("workspace_id");--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ADD CONSTRAINT "workspace_write_jobs_workspace_id_workspaces_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE;