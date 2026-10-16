import type { Workflow } from "openworkflow"
import type { Env } from "../../config/env.js"
import {
  type IngestionPublishPipeline,
  ingestionPublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import { withIngestionOrg } from "../../domain/ingestion/ingestion-v2-resolve.js"
import { ownershipMigrationFiles } from "../../domain/ingestion/ownership-migration.js"
import { githubSourcePathsByRepository } from "../../domain/workspace-sources/github-sources.js"
import { resolveWorkspaceReadRevision } from "../../domain/workspaces/resolve-revision.js"
import { log } from "../../observability/logger.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { defineKnowledgeRewriteWorkflow } from "./workspace-knowledge-rewrite.js"

/**
 * The one-time move of old extracted files to ingestion v2 ownership
 * (ADR-052 section 3). Hydrate queues it while ingestion v2 publishes, and
 * an ingestion v2 run that publishes runs it first
 * (`migrateOwnershipBeforePublish`). It is an ingestion v2 publish: a job
 * that was not queued under v2, or that pushes after a switch back to
 * legacy, stops. `committedPipeline` reads the committed switch at push
 * time; a test gives the value that it checks.
 */
export function defineWorkspaceOwnershipMigrationWorkflow(
  deps: { committedPipeline?: () => IngestionPublishPipeline } = {},
) {
  return defineKnowledgeRewriteWorkflow({
    name: "workspace-write-ownership-migration",
    kind: "ownership_migration",
    publishPipeline: {
      committed: deps.committedPipeline ?? ingestionPublishPipeline,
    },
    transform: (files, revision, sourceFiles) =>
      ownershipMigrationFiles({
        workspaceRepositoryUrl: revision.remote.url,
        sourcePaths: githubSourcePathsByRepository(sourceFiles),
        files,
        onDroppedClaim: (drop) =>
          log.warn({
            step: "workspace-ownership-migration.claim_dropped",
            workspaceId: revision.workspaceId,
            ...drop,
          }),
      }),
  })
}

export const workspaceOwnershipMigration =
  defineWorkspaceOwnershipMigrationWorkflow()

type Step = Parameters<Workflow<unknown, unknown, unknown>["fn"]>[0]["step"]

/**
 * Run the ownership migration in each Workspace, one child workflow each,
 * before an ingestion v2 run publishes to it. Hydrate queues the migration
 * only when a Workspace changes, so an idle Workspace can get its first v2
 * publish before hydrate runs; without this step its old files are foreign
 * to ingestion v2. The migration is idempotent: a Workspace with no old file
 * makes no commit. `committed` is true when a migration made a commit, so the
 * caller must read the Workspace revisions again. A migration that fails
 * (for example, the default branch moves at each read) fails only its
 * Workspace: `failed` names it, and the run goes on with the others.
 */
export async function migrateOwnershipBeforePublish(input: {
  step: Step
  orgId: string
  runId: string
  /** The pipeline in the run input: the migration job carries it. */
  publishPipeline: IngestionPublishPipeline
  workspaceIds: readonly string[]
  env: Env
}): Promise<{ committed: boolean; failed: string[] }> {
  let committed = false
  const failed: string[] = []
  for (const workspaceId of input.workspaceIds) {
    try {
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
          publishPipeline: input.publishPipeline,
        },
        { name: `ownership-migration:${workspaceId}` },
      )
      if (result.committed) committed = true
    } catch (error) {
      // A control signal parks the run while the child runs.
      if (isWorkflowControlSignal(error)) throw error
      failed.push(workspaceId)
      // A fixed code: the cause text can hold repository text.
      log.warn({
        step: "ingestion-v2.ownership-migration-failed",
        workspaceId,
      })
    }
  }
  return { committed, failed }
}
