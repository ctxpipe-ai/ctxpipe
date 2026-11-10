-- The Workspace write workflows stored Git packs and file contents in the
-- outputs of steps that CTX-1235 retired (the table in its PR), and the
-- retired migration export workflow (ADR-053) stored its results. No code reads these outputs again.
-- Clear them and keep the rows: other code reads the rows. OpenWorkflow adds
-- `:N` to a step name that repeats in a run. The selection uses the workflow
-- name, the run status and the step name only: a read of `output` would load
-- the stored packs. Only finished runs: a run that can still resume keeps its
-- outputs.
-- A new database has no OpenWorkflow schema yet: the OpenWorkflow migration
-- runs after Drizzle. A second run clears nothing.
DO $$
BEGIN
  IF to_regclass('openworkflow.step_attempts') IS NOT NULL THEN
    UPDATE "openworkflow"."step_attempts" AS sa
    SET "output" = NULL
    FROM "openworkflow"."workflow_runs" AS wr
    WHERE wr."namespace_id" = sa."namespace_id"
      AND wr."id" = sa."workflow_run_id"
      AND wr."workflow_name" LIKE 'workspace-write-%'
      AND wr."status" IN ('completed', 'succeeded', 'failed', 'canceled')
      AND (wr."workflow_name" = 'workspace-write-migration-export'
        OR regexp_replace(sa."step_name", ':[0-9]+$', '') IN (
        'acquire-revision',
        'stage',
        'validate',
        'commit',
        'transform-connector-mirror',
        'transform-semantic-merge',
        'resolve-semantic-conflicts',
        'confirm-resolved-no-op',
        'enqueue-resolved-no-op-hydrate',
        'complete-resolved-no-op',
        'stage-unborn',
        'validate-unborn',
        'commit-unborn',
        'commit-subject',
        'commit-subject-unborn',
        'capture-semantic-handoff',
        'read-introducing-commits',
        'transform-file-edit',
        'transform-extract-ingest',
        'transform-valid-from-persist',
        'transform-claims-upgrade',
        'transform-rename-rewrite',
        'transform-ops-folder-list',
        'transform-unlink-retraction',
        'transform-import-key-cleanup',
        'transform-ownership-migration',
        'transform-bootstrap',
        'transform-unborn'
      ))
      AND sa."output" IS NOT NULL;
  END IF;
END
$$;
--> statement-breakpoint
-- LangGraph was removed in CTX-601. No code reads these tables. A database
-- without them passes.
DROP TABLE IF EXISTS "public"."checkpoint_writes";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoint_blobs";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoints";
--> statement-breakpoint
DROP TABLE IF EXISTS "public"."checkpoint_migrations";
