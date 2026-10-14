import { gunzipSync, gzipSync } from "node:zlib"
import type { Workflow } from "openworkflow"
import { parseEnv } from "../../config/env.js"
import { IngestRefRefusedError } from "../../domain/ingestion/ingest-refs.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  planIngestRoots,
  plannedIngestSkills,
} from "../../domain/ingestion/ingestion-plan.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  ingestionV2InputSchema,
} from "../../domain/ingestion/ingestion-run.js"
import {
  resolveIngestionV2Run,
  withIngestionOrg,
} from "../../domain/ingestion/ingestion-v2-resolve.js"
import { resolveSemanticConflicts } from "../../domain/workspaces/semantic-merge.js"
import { pushWorkspaceIngestAssemble } from "../../domain/workspaces/write-broker.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { cleanUpUnlessParked } from "../isSleepSignal.js"
import {
  type IngestionRoot,
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
 *   resolve -> index -> discover-roots -> shard:<n> (children)
 *   -> assemble:<workspaceId> -> repository-skills (child) -> release
 *
 * `discover-roots` runs once, in the sandbox of shard 0, and the host check
 * (`resolveDiscoveredRoots`) plans the roots. Each shard gets its explicit
 * root list. Step outputs hold ref SHAs and counts; the one larger output is
 * the compressed root list, which the root cap keeps far below 16 KB.
 * Nothing publishes: the refs stay for the comparison (T20). T21 adds publish.
 */

/** Shards run in parallel, a few at a time. */
const SHARD_BATCH = 4

export type IngestionV2Output =
  | { status: "skipped"; reason: string }
  | { status: "partial"; reason: string }
  | {
      status: "done"
      shards: number
      workspaces: Array<{
        workspaceId: string
        /** The assembled ref tip; null when assemble did not finish. */
        assembled: string | null
        ops: number
        rejects: number
        partial: number
        refused?: string
      }>
    }

export function defineRepositoryIngestionV2Workflow(
  deps: IngestionV2Deps & {
    shard: {
      spec: Workflow<
        IngestionShardInput,
        IngestionShardOutput,
        IngestionShardInput
      >["spec"]
    }
  },
) {
  const env = deps.env ?? (() => parseEnv(process.env))
  return defineWorkflow(
    {
      name: INGESTION_V2_WORKFLOW_NAME,
      schema: ingestionV2InputSchema,
    },
    async ({ input, step, run }) => {
      return withLogger(
        createLogger({
          workflow: INGESTION_V2_WORKFLOW_NAME,
          orgId: input.orgId,
          ingestionRunId: run.id,
          sourceSha: input.sha,
        }),
        // A failed run also deletes the worker's copy of the source tree.
        () =>
          cleanUpUnlessParked(
            () => ingest(),
            () => releaseIngestSourceTree(run.id, input.sha),
          ),
      )

      async function ingest(): Promise<IngestionV2Output> {
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
          }
        const { destinations, sourceRepositoryId } = resolved
        const source = {
          ...input.source,
          sha: input.sha,
          repositoryId: sourceRepositoryId,
        }

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

        // The shard-0 sandbox runs discovery; shard 0 then uses it, and
        // `release` destroys it in each case.
        const release = () =>
          step.run({ name: "release" }, async () => {
            await deps.runtime.destroy({
              orgId: input.orgId,
              runId: run.id,
              shard: 0,
              workspaceId: destinations[0]?.workspaceId ?? "",
            })
            return { released: true }
          })

        const scope = await step.run({ name: "discover-roots" }, async () => {
          const bundle = await deps.bundle()
          const discovered = await deps
            .runtime({
              orgId: input.orgId,
              runId: run.id,
              shard: 0,
              bundle,
              source,
              destinations,
            })
            .discoverRoots()
          const plan = planIngestRoots(discovered)
          for (const refused of plan.refused)
            getLogger().warn("ingestion-v2.root-refused", refused)
          const packed = plan.partial === undefined ? packRoots(plan.roots) : ""
          const partial =
            plan.partial ??
            (packed.length > 12_000
              ? "The root list is too large for one step output"
              : undefined)
          if (partial !== undefined) {
            getLogger().warn("ingestion-v2.partial", { reason: partial })
            return { partial }
          }
          return {
            bundle: bundle.name,
            roots: packed,
            repositorySkills: plannedIngestSkills(bundle.skills, "repository")
              .length,
          }
        })
        if (scope.partial !== undefined) {
          await release()
          return { status: "partial", reason: scope.partial }
        }
        const roots = unpackRoots(scope.roots)
        const shards = Math.ceil(roots.length / INGEST_SHARD_MAX_ROOTS)

        const child = (
          shard: number,
          mode: IngestionShardInput["mode"],
          shardRoots: IngestionRoot[],
          startTips?: Record<string, string>,
        ): IngestionShardInput => ({
          orgId: input.orgId,
          runId: run.id,
          shard,
          mode,
          roots: shardRoots,
          bundle: scope.bundle,
          source,
          authorTime: input.authorTime,
          destinations,
          ...(startTips ? { startTips } : {}),
        })
        const shardOutputs: IngestionShardOutput[] = []
        for (let n = 0; n < shards; n += SHARD_BATCH)
          shardOutputs.push(
            ...(await Promise.all(
              Array.from(
                { length: Math.min(SHARD_BATCH, shards - n) },
                (_, i) =>
                  step.runWorkflow(
                    deps.shard.spec,
                    child(
                      n + i,
                      "roots",
                      roots.slice(
                        (n + i) * INGEST_SHARD_MAX_ROOTS,
                        (n + i + 1) * INGEST_SHARD_MAX_ROOTS,
                      ),
                    ),
                    { name: `shard:${n + i}` },
                  ),
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
          const assembleStep = `assemble:${destination.workspaceId}`
          const assembled = await step.run(
            {
              name: assembleStep,
              retryPolicy: { maximumAttempts: 3, initialInterval: "10s" },
            },
            async (): Promise<
              | { tip: string; ops: number }
              | { tip: null; ops: 0; refused: string }
            > => {
              try {
                const result = await withIngestionOrg(input.orgId, () =>
                  pushWorkspaceIngestAssemble(
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
                        step: assembleStep,
                        bundle: scope.bundle,
                        authorTime: new Date(input.authorTime),
                      },
                      // Two shards that change one path: the semantic
                      // merge, whose files the patch validator checks.
                      semanticMerge: {
                        resolve: resolveSemanticConflicts,
                        source: { url: input.source.url, sha: input.sha },
                        sourcePathExists: (path) =>
                          ingestSourceTree({
                            orgId: input.orgId,
                            runId: run.id,
                            source: input.source,
                            sha: input.sha,
                            env: env(),
                          }).exists(path),
                      },
                    },
                    env(),
                  ),
                )
                return { tip: result.sha, ops: result.ops }
              } catch (error) {
                if (!(error instanceof IngestRefRefusedError)) throw error
                getLogger().warn("ingestion-v2.partial", {
                  step: assembleStep,
                  workspaceId: destination.workspaceId,
                  reason: error.message,
                })
                return {
                  tip: null,
                  ops: 0,
                  refused: error.message.slice(0, 300),
                }
              }
            },
          )
          workspaces.push({
            workspaceId: destination.workspaceId,
            assembled: assembled.tip,
            ops: assembled.ops,
            rejects: parts.reduce((sum, p) => sum + p.rejects, 0),
            partial: parts.reduce((sum, p) => sum + p.partial, 0),
            ...("refused" in assembled ? { refused: assembled.refused } : {}),
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
              ...child(shards, "repository", roots, startTips),
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
            entry.ops += done.ops
            entry.rejects += done.rejects
            entry.partial += done.partial
          }
        }

        await release()
        getLogger().info("ingestion-v2.finished", {
          shards,
          roots: roots.length,
          workspaces: workspaces.length,
          ops: workspaces.reduce((sum, w) => sum + w.ops, 0),
          partial: workspaces.reduce((sum, w) => sum + w.partial, 0),
        })
        return { status: "done", shards, workspaces }
      }
    },
  )
}

/** The root list in a step output: gzip, then base64. */
function packRoots(roots: IngestionRoot[]): string {
  return gzipSync(
    JSON.stringify(
      roots.map((r) => ({
        path: r.path,
        manifests: r.manifests,
        evidence: r.evidence,
      })),
    ),
  ).toString("base64")
}

function unpackRoots(packed: string): IngestionRoot[] {
  return JSON.parse(gunzipSync(Buffer.from(packed, "base64")).toString("utf8"))
}

export const repositoryIngestionV2 = defineRepositoryIngestionV2Workflow({
  ...productionIngestionV2Deps,
  shard: ingestionShard,
})
