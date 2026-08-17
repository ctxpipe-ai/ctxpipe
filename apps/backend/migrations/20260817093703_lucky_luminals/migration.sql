ALTER TABLE "workspace_write_jobs" ADD COLUMN "status" text DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE "workspace_write_jobs" ADD COLUMN "payload" jsonb;--> statement-breakpoint
CREATE INDEX "workspace_write_jobs_workspace_id_status_idx" ON "workspace_write_jobs" ("workspace_id","status");