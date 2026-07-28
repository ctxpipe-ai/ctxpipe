UPDATE "repositories"
SET
  "indexing_status" = 'queued',
  "indexing_reason" = 'scip-migration',
  "updated_at" = NOW()
WHERE "last_ingested_hash" IS NOT NULL OR "index_ready" = true;
--> statement-breakpoint
-- Keep this column list aligned with OpenWorkflow 0.8.0's
-- BackendPostgres.insertWorkflowRun (the implementation behind ow.runWorkflow).
-- This direct SQL enqueue cannot call runWorkflowWithWorkerWake, so Railway must
-- already have an active worker (or be woken separately) to consume these runs.
INSERT INTO "openworkflow"."workflow_runs" (
  "namespace_id",
  "id",
  "workflow_name",
  "version",
  "status",
  "idempotency_key",
  "config",
  "context",
  "input",
  "attempts",
  "parent_step_attempt_namespace_id",
  "parent_step_attempt_id",
  "available_at",
  "deadline_at",
  "created_at",
  "updated_at"
)
SELECT
  'default',
  gen_random_uuid(),
  'repository-ingestion-orchestrator',
  NULL,
  'pending',
  NULL,
  '{}'::jsonb,
  NULL,
  jsonb_build_object(
    'repositoryId', "id",
    'orgId', "org_id",
    'indexingReason', 'scip-migration'
  ),
  0,
  NULL,
  NULL,
  NOW(),
  NULL,
  date_trunc('milliseconds', NOW()),
  NOW()
FROM "repositories"
WHERE "last_ingested_hash" IS NOT NULL OR "index_ready" = true;