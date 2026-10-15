-- The link-unlink write workflow no longer exists. A run of it that is still
-- pending, running, or sleeping hits a missing definition and retries every
-- few minutes without end. Cancel those runs, and fail their job rows.
-- The OpenWorkflow schema is created after this migration on a fresh database,
-- so cancel the runs only when the table already exists.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'openworkflow'
      AND table_name = 'workflow_runs'
  ) THEN
    UPDATE "openworkflow"."workflow_runs"
    SET
      "status" = 'canceled',
      "worker_id" = NULL,
      "available_at" = NULL,
      "finished_at" = NOW(),
      "updated_at" = NOW()
    WHERE "workflow_name" = 'workspace-write-link-unlink'
      AND "status" IN ('pending', 'running', 'sleeping');
  END IF;
END $$;
--> statement-breakpoint
-- Keep the old `link_unlink` kind in old rows. Only end the open jobs.
UPDATE "workspace_write_jobs"
SET
  "status" = 'failed',
  "payload" = COALESCE("payload", '{}'::jsonb) || jsonb_build_object(
    'failureReason',
    'The link-unlink write job was retired. Change sources with a pull request on .ctxpipe/sources.yaml.'
  ),
  "updated_at" = NOW()
WHERE "kind" = 'link_unlink'
  AND "status" NOT IN ('completed', 'failed');
