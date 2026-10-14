import { parseEnv } from "../../config/env.js"
import {
  IngestAssembleConflictError,
  IngestRefRefusedError,
} from "../../domain/ingestion/ingest-refs.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import {
  ingestShardCount,
  plannedIngestSkills,
  sourceCandidateRoots,
} from "../../domain/ingestion/ingestion-plan.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  ingestionV2InputSchema,
} from "../../domain/ingestion/ingestion-run.js"
import { resolveIngestionV2Run } from "../../domain/ingestion/ingestion-v2-resolve.js"
import { pushWorkspaceIngestAssemble } from "../../domain/workspaces/write-broker.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  type defineIngestionShardWorkflow,
  type IngestionShardInput,
  type IngestionShardOutput,
  type IngestionV2Deps,
  ingestionShard,
  productionIngestionV2Deps,
} from "./ingestion-shard.js"
import { repositoryIndex } from "./repository-index.js"

/*
 * The ingestion v2 parent workflow (ADR-052, T09), in shadow mode only:
 *
 *   resolve -> index -> plan-scope -> plan-shards -> shard:<n> (children)
 *   -> assemble:<workspaceId> -> repository-skills (child) -> finalize
 *
 * Each step output holds only ref SHAs and counts. Nothing publishes: the
 * refs stay for the comparison (T20), and the clean-up removes them 7 days
 * after the run. The old pipeline still publishes. T21 adds publish.
 */

/** Shards run in parallel, a few at a time. */
const SHARD_BATCH = 4

export type IngestionV2Output =
  | { status: "skipped"; reason: string; shadow: boolean }
  | {
      status: "done"
      shadow: boolean
      shards: number
      workspaces: Array<{
        workspaceId: string
        /** The assembled ref tip; null when assemble did not finish. */
        assembled: string | null
        ops: number
        rejects: number
        partial: number
        /** Paths that two shards changed; the semantic merge gets them (T21). */
        conflicts: number
        refused?: string
      }>
    }

export function defineRepositoryIngestionV2Workflow(
  deps: IngestionV2Deps & {
    shard: ReturnType<typeof defineIngestionShardWorkflow>
  },
) {
  const env = deps.env ?? (() => parseEnv(process.env))
  return defineWorkflow(
    {
      name: INGESTION_V2_WORKFLOW_NAME,
      schema: ingestionV2InputSchema,
    },
    async ({ input, step, run }) =>
      withLogger(
        createLogger({
          workflow: INGESTION_V2_WORKFLOW_NAME,
          orgId: input.orgId,
          ingestionRunId: run.id,
          sourceSha: input.sha,
        }),
        async (): Promise<IngestionV2Output> => {
          if (!input.shadow)
            // Publish from the ref is T21. Until then a run must not
            // replace the old pipeline's output.
            throw new Error("Ingestion v2 runs only in shadow mode")

          const resolved = await step.run({ name: "resolve" }, () =>
            resolveIngestionV2Run(input),
          )
          if (resolved.skipped || resolved.destinations.length === 0)
            return {
              status: "skipped",
              reason: resolved.skipped ?? "no_writable_destination",
              shadow: input.shadow,
            }
          const { destinations, sourceRepositoryId } = resolved

          if (sourceRepositoryId)
            // The same SHA as the old pipeline: codesearch reuses its index.
            await step.runWorkflow(
              repositoryIndex.spec,
              {
                repositoryId: sourceRepositoryId,
                orgId: input.orgId,
                targetHash: input.sha,
                githubConnectionId: input.source.githubConnectionId,
              },
              { name: "index" },
            )

          const scope = await step.run({ name: "plan-scope" }, async () => {
            const tree = ingestSourceTree({
              orgId: input.orgId,
              runId: run.id,
              source: input.source,
              sha: input.sha,
              env: env(),
            })
            const roots = sourceCandidateRoots(await tree.paths()).length
            await releaseIngestSourceTree(run.id, input.sha)
            const bundle = await deps.bundle()
            return {
              roots,
              bundle: bundle.name,
              repositorySkills: plannedIngestSkills(bundle.skills, "repository")
                .length,
            }
          })
          const plan = await step.run({ name: "plan-shards" }, async () => ({
            shards: ingestShardCount(scope.roots),
          }))

          const child = (
            shard: number,
            mode: IngestionShardInput["mode"],
            startTips?: Record<string, string>,
          ): IngestionShardInput => ({
            orgId: input.orgId,
            runId: run.id,
            shard,
            shards: plan.shards,
            mode,
            bundle: scope.bundle,
            source: {
              ...input.source,
              sha: input.sha,
              repositoryId: sourceRepositoryId,
            },
            authorTime: input.authorTime,
            destinations,
            ...(startTips ? { startTips } : {}),
          })
          const shardOutputs: IngestionShardOutput[] = []
          for (let n = 0; n < plan.shards; n += SHARD_BATCH)
            shardOutputs.push(
              ...(await Promise.all(
                Array.from(
                  { length: Math.min(SHARD_BATCH, plan.shards - n) },
                  (_, i) =>
                    step.runWorkflow(deps.shard.spec, child(n + i, "roots"), {
                      name: `shard:${n + i}`,
                    }),
                ),
              )),
            )

          const workspaces: Extract<
            IngestionV2Output,
            { status: "done" }
          >["workspaces"] = []
          for (const destination of destinations) {
            const parts = shardOutputs.flatMap((output) =>
              output.workspaces
                .filter((w) => w.workspaceId === destination.workspaceId)
                .map((w) => ({ shard: output.shard, ...w })),
            )
            const assembled = await step.run(
              {
                name: `assemble:${destination.workspaceId}`,
                retryPolicy: { maximumAttempts: 3, initialInterval: "10s" },
              },
              async () => {
                try {
                  const result = await pushWorkspaceIngestAssemble(
                    {
                      orgId: input.orgId,
                      job: {
                        runId: run.id,
                        workspaceId: destination.workspaceId,
                        generation: destination.generation,
                      },
                      pinnedRevision: destination.pinnedRevision,
                      shards: parts.flatMap((p) =>
                        p.tip ? [{ shard: String(p.shard), tip: p.tip }] : [],
                      ),
                      oldTip: null,
                      commit: {
                        step: `assemble:${destination.workspaceId}`,
                        bundle: scope.bundle,
                        authorTime: new Date(input.authorTime),
                      },
                    },
                    env(),
                  )
                  return { tip: result.sha, ops: result.ops, conflicts: 0 }
                } catch (error) {
                  if (error instanceof IngestAssembleConflictError) {
                    getLogger().warn("ingestion-v2.assemble-conflict", {
                      workspaceId: destination.workspaceId,
                      conflicts: error.paths.length,
                    })
                    return { tip: null, ops: 0, conflicts: error.paths.length }
                  }
                  if (error instanceof IngestRefRefusedError)
                    return {
                      tip: null,
                      ops: 0,
                      conflicts: 0,
                      refused: error.message.slice(0, 300),
                    }
                  throw error
                }
              },
            )
            workspaces.push({
              workspaceId: destination.workspaceId,
              assembled: assembled.tip,
              ops: assembled.ops,
              rejects: parts.reduce((sum, p) => sum + p.rejects, 0),
              partial: parts.reduce((sum, p) => sum + p.partial, 0),
              conflicts: assembled.conflicts,
              ...("refused" in assembled && assembled.refused
                ? { refused: assembled.refused }
                : {}),
            })
          }

          const startTips = Object.fromEntries(
            workspaces.flatMap((w) =>
              w.assembled ? [[w.workspaceId, w.assembled]] : [],
            ),
          )
          const ready = destinations.filter((d) => startTips[d.workspaceId])
          if (scope.repositorySkills > 0 && ready.length) {
            const repository = await step.runWorkflow(
              deps.shard.spec,
              {
                ...child(plan.shards, "repository", startTips),
                destinations: ready,
              },
              { name: "repository-skills" },
            )
            for (const done of repository.workspaces) {
              const entry = workspaces.find(
                (w) => w.workspaceId === done.workspaceId,
              )
              if (!entry) continue
              entry.assembled = done.tip ?? entry.assembled
              entry.rejects += done.rejects
              entry.partial += done.partial
            }
          }

          return step.run({ name: "finalize" }, async () => {
            getLogger().info("ingestion-v2.finished", {
              shards: plan.shards,
              workspaces: workspaces.length,
              ops: workspaces.reduce((sum, w) => sum + w.ops, 0),
              partial: workspaces.reduce((sum, w) => sum + w.partial, 0),
            })
            return {
              status: "done" as const,
              shadow: input.shadow,
              shards: plan.shards,
              workspaces,
            }
          })
        },
      ),
  )
}

export const repositoryIngestionV2 = defineRepositoryIngestionV2Workflow({
  ...productionIngestionV2Deps,
  shard: ingestionShard,
})
