import type { Pool } from "pg"

import { log } from "../observability/logger.js"

/**
 * Clears the outputs of the retired write steps in finished runs and keeps the
 * rows (CTX-1236). Migrate runs it after Drizzle, outside its transaction: the
 * clear touches about 150 GB of TOAST in production, and in the one transaction
 * of a deploy it ran for more than 9 minutes. Each batch commits on its own, and
 * a keyset cursor moves past the rows that a batch cleared, so a stopped run
 * keeps its progress. Each run stops at a time budget. The selection uses the workflow name, the run status and
 * the step name only: a read of `output` would load the stored packs. Every
 * output of the retired migration export workflow (ADR-053) goes too. It is
 * idempotent; once production is clean, the next major release removes it.
 */
export async function clearRetiredWriteStepOutputs(
  pool: Pool,
  { batchSize = 200, budgetMs = 300_000 } = {},
): Promise<{ cleared: number; done: boolean }> {
  // The Workspace write steps that CTX-1235 retired (the table of retired
  // steps in PR #641).
  const retiredSteps = [
    "acquire-revision",
    "stage",
    "validate",
    "commit",
    "transform-connector-mirror",
    "transform-semantic-merge",
    "resolve-semantic-conflicts",
    "confirm-resolved-no-op",
    "enqueue-resolved-no-op-hydrate",
    "complete-resolved-no-op",
    "stage-unborn",
    "validate-unborn",
    "commit-unborn",
    "commit-subject",
    "commit-subject-unborn",
    "capture-semantic-handoff",
    "read-introducing-commits",
    "transform-file-edit",
    "transform-extract-ingest",
    "transform-valid-from-persist",
    "transform-claims-upgrade",
    "transform-rename-rewrite",
    "transform-ops-folder-list",
    "transform-unlink-retraction",
    "transform-import-key-cleanup",
    "transform-ownership-migration",
    "transform-bootstrap",
    "transform-unborn",
  ]
  const started = Date.now()
  let cursor = { namespace: "", id: "" }
  let total = 0
  let done = false
  // The migrate step of a deploy has 20 minutes: a run stops at the budget,
  // and the next migrate goes on, because a cleared output is not selected
  // again.
  while (Date.now() - started < budgetMs) {
    const { rows: batch } = await pool.query<{
      cleared: string
      namespace: string | null
      id: string | null
    }>(
      `WITH batch AS (
         SELECT sa."namespace_id", sa."id"
         FROM "openworkflow"."step_attempts" AS sa
         JOIN "openworkflow"."workflow_runs" AS wr
           ON wr."namespace_id" = sa."namespace_id"
          AND wr."id" = sa."workflow_run_id"
         WHERE (sa."namespace_id", sa."id") > ($1, $2)
           AND wr."workflow_name" LIKE 'workspace-write-%'
           AND wr."status" IN ('completed', 'succeeded', 'failed', 'canceled')
           AND (wr."workflow_name" = 'workspace-write-migration-export'
             OR regexp_replace(sa."step_name", ':[0-9]+$', '') = ANY($3::text[]))
           AND sa."output" IS NOT NULL
         ORDER BY sa."namespace_id", sa."id"
         LIMIT $4
       ),
       cleared AS (
         UPDATE "openworkflow"."step_attempts" AS sa
         SET "output" = NULL
         FROM batch
         WHERE sa."namespace_id" = batch."namespace_id"
           AND sa."id" = batch."id"
         RETURNING 1
       ),
       last AS (
         SELECT "namespace_id", "id" FROM batch
         ORDER BY "namespace_id" DESC, "id" DESC
         LIMIT 1
       )
       SELECT (SELECT count(*) FROM cleared) AS cleared,
              (SELECT "namespace_id" FROM last) AS namespace,
              (SELECT "id" FROM last) AS id`,
      [cursor.namespace, cursor.id, retiredSteps, batchSize],
    )
    const row = batch[0]
    if (!row?.namespace || row.id === null) {
      done = true
      break
    }
    total += Number(row.cleared)
    cursor = { namespace: row.namespace, id: row.id }
  }
  if (total > 0 || !done)
    log.info({
      step: "migrate",
      message: done
        ? "[migrate] cleared the outputs of retired write steps"
        : "[migrate] cleared outputs of retired write steps up to the time budget; the next migrate goes on",
      cleared: total,
      done,
    })
  return { cleared: total, done }
}
