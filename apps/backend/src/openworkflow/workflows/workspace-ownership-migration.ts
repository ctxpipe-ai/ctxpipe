import type { Workflow } from "openworkflow"
import type { Env } from "../../config/env.js"
import { withIngestionOrg } from "../../domain/ingestion/ingestion-v2-resolve.js"
import { ownershipMigrationFiles } from "../../domain/ingestion/ownership-migration.js"
import { resolveWorkspaceReadRevision } from "../../domain/workspaces/resolve-revision.js"
import { log } from "../../observability/logger.js"
import { defineKnowledgeRewriteWorkflow } from "./workspace-knowledge-rewrite.js"

/**
 * The one-time move of old extracted files to ingestion v2 ownership
 * (ADR-052 section 3). Hydrate queues it while ingestion v2 publishes, and
 * an ingestion v2 run that publishes runs it first
 * (`migrateOwnershipBeforePublish`).
 */
export const workspaceOwnershipMigration = defineKnowledgeRewriteWorkflow({
  name: "workspace-write-ownership-migration",
  kind: "ownership_migration",
  transform: (files, revision) =>
    ownershipMigrationFiles({
      workspaceRepositoryUrl: revision.remote.url,
      files,
      onDroppedClaim: (drop) =>
        log.warn({
          step: "workspace-ownership-migration.claim_dropped",
          workspaceId: revision.workspaceId,
          ...drop,
        }),
    }),
})

type Step = Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"]

/**
 * Run the ownership migration in each Workspace, one child workflow each,
 * before an ingestion v2 run publishes to it. Hydrate queues the migration
 * only when a Workspace changes, so an idle Workspace can get its first v2
 * publish before hydrate runs; without this step its old files are foreign
 * to ingestion v2. The migration is idempotent: a Workspace with no old file
 * makes no commit. It returns true when a migration made a commit, so the
 * caller must read the Workspace revisions again.
 */
export async function migrateOwnershipBeforePublish(input: {
  step: Step
  orgId: string
  runId: string
  workspaceIds: readonly string[]
  env: Env
}): Promise<boolean> {
  let committed = false
  for (const workspaceId of input.workspaceIds) {
    const revision = await input.step.run(
      { name: `ownership-revision:${workspaceId}` },
      async () => {
        const resolved = await withIngestionOrg(input.orgId, () =>
          resolveWorkspaceReadRevision({
            orgId: input.orgId,
            workspaceId,
            env: input.env,
            refresh: true,
          }),
        )
        if (!resolved) throw new Error("The Workspace has no revision")
        // The token stays out of the step output.
        return { ...resolved.revision, access: "write-default" as const }
      },
    )
    const result = await input.step.runWorkflow(
      workspaceOwnershipMigration.spec,
      {
        orgId: input.orgId,
        workspaceId,
        jobId: `wjob_${input.runId}_${workspaceId}_ownership`,
        revision,
      },
      { name: `ownership-migration:${workspaceId}` },
    )
    if (result.committed) committed = true
  }
  return committed
}
