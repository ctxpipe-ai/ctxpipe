-- Clears the outputs of the Workspace write steps that CTX-1235 retired, in
-- finished runs, and keeps the rows (CTX-1236). No code reads these outputs
-- again. Run it with psql against a database (autocommit): it commits after
-- each batch, so no long transaction holds the rows, and it can stop and run
-- again. The selection uses the workflow name, the run status and the step
-- name only: a read of `output` would load the stored packs.
DO $$
DECLARE
  cleared integer;
BEGIN
  IF to_regclass('openworkflow.step_attempts') IS NULL THEN
    RETURN;
  END IF;
  LOOP
    WITH batch AS (
      SELECT sa."namespace_id", sa."id"
      FROM "openworkflow"."step_attempts" AS sa
      JOIN "openworkflow"."workflow_runs" AS wr
        ON wr."namespace_id" = sa."namespace_id"
       AND wr."id" = sa."workflow_run_id"
      WHERE wr."workflow_name" LIKE 'workspace-write-%'
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
      AND sa."output" IS NOT NULL
      LIMIT 200
      FOR UPDATE OF sa SKIP LOCKED
    )
    UPDATE "openworkflow"."step_attempts" AS sa
    SET "output" = NULL
    FROM batch
    WHERE sa."namespace_id" = batch."namespace_id"
      AND sa."id" = batch."id";
    GET DIAGNOSTICS cleared = ROW_COUNT;
    RAISE NOTICE 'cleared % step outputs', cleared;
    EXIT WHEN cleared = 0;
    COMMIT;
  END LOOP;
END
$$;
