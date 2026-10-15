import { gunzipSync, gzipSync } from "node:zlib"
import type { Attributes } from "@opentelemetry/api"
import type { Workflow } from "openworkflow"
import { parseEnv } from "../../config/env.js"
import {
  IngestRefRefusedError,
  ingestRefName,
} from "../../domain/ingestion/ingest-refs.js"
import { releaseIngestStepIndexes } from "../../domain/ingestion/ingest-shard-sandbox.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import {
  capIngestText,
  logIngestEvent,
  withIngestRunSpan,
} from "../../domain/ingestion/ingest-telemetry.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  planIngestRoots,
  plannedIngestSkills,
} from "../../domain/ingestion/ingestion-plan.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  ingestionV2InputSchema,
  ingestionV2Status,
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
import { cleanUpUnlessParked, settledChildren } from "../isSleepSignal.js"
import {
  type IngestionRoot,
  type IngestionShardInput,
  type IngestionShardOutput,
  type IngestionShardWorkspace,
  type IngestionV2Deps,
  ingestionShard,
  productionIngestionV2Deps,
  runSkillPages,
  workspaceSkillBroker,
} from "./ingestion-shard.js"
import { repositoryIndex } from "./repository-index.js"

/*
 * The ingestion v2 parent workflow (ADR-052, T09), in shadow mode only:
 *
 *   resolve -> index -> discover-roots -> skill:repository:repository
 *   -> shard:<n> (children) -> assemble:<workspaceId>
 *   -> repository-skills (child) -> release
 *
 * `discover-roots` runs once, in the sandbox of shard 0, and the host check
 * (`resolveDiscoveredRoots`) plans the roots. Each shard gets its explicit
 * root list. Step outputs hold ref SHAs and counts; the one larger output is
 * the compressed root list, which the root cap keeps far below 16 KB.
 * The `repository` skill runs in the parent, in the sandbox of shard 0, and
 * writes the repository unit on the assembled ref. Its tip is the run base
 * of each Workspace: the shard refs start there, and `assemble` merges the
 * shard tips against it (ADR-052 section 6).
 * Nothing publishes: the refs stay for the comparison (T20). T21 adds publish.
 */

/** Shards run in parallel, a few at a time. */
const SHARD_BATCH = 4

export type IngestionV2Output =
  | { status: "skipped"; reason: string }
  | { status: "partial"; reason: string }
  | {
      /** `partial` when a Workspace is refused or has a `partial` step. */
      status: "done" | "partial"
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
        // A failed run also deletes the worker's copy of the source tree,
        // and the index repositories of its repository step (shard 0).
        () =>
          cleanUpUnlessParked(
            () => ingestWithSpan(),
            async () => {
              await releaseIngestSourceTree(run.id, input.sha)
              await releaseIngestStepIndexes(run.id, 0)
            },
          ),
      )

      // Export one summary for the terminal execution. Shards run in separate
      // workflows; their spans share the run id, not a parent span.
      function ingestWithSpan(): Promise<IngestionV2Output> {
        return withIngestRunSpan(
          {
            "ctxpipe.org.id": input.orgId,
            "ctxpipe.ingest.run.id": run.id,
            "ctxpipe.ingest.source.sha": input.sha,
            "ctxpipe.ingest.mode": input.shadow ? "shadow" : "publish",
          },
          async (attributes) => {
            const output = await ingest(attributes)
            attributes["ctxpipe.ingest.status"] = output.status
            if ("reason" in output)
              attributes["ctxpipe.ingest.reason"] = capIngestText(output.reason)
            if ("workspaces" in output)
              Object.assign(attributes, {
                "ctxpipe.ingest.shards": output.shards,
                "ctxpipe.ingest.workspaces": output.workspaces.length,
                "ctxpipe.ingest.ops": output.workspaces.reduce(
                  (sum, w) => sum + w.ops,
                  0,
                ),
                "ctxpipe.ingest.rejects": output.workspaces.reduce(
                  (sum, w) => sum + w.rejects,
                  0,
                ),
                "ctxpipe.ingest.partial": output.workspaces.reduce(
                  (sum, w) => sum + w.partial,
                  0,
                ),
              })
            return output
          },
        )
      }

      async function ingest(
        attributes: Attributes,
      ): Promise<IngestionV2Output> {
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
            logIngestEvent("warn", "ingestion-v2.root-refused", {
              ingestionRunId: run.id,
              ...refused,
            })
          const packed = plan.partial === undefined ? packRoots(plan.roots) : ""
          const partial =
            plan.partial ??
            (packed.length > 12_000
              ? "The root list is too large for one step output"
              : undefined)
          if (partial !== undefined) {
            logIngestEvent("warn", "ingestion-v2.partial", {
              ingestionRunId: run.id,
              reason: capIngestText(partial),
            })
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
        Object.assign(attributes, {
          "ctxpipe.ingest.bundle": scope.bundle,
          "ctxpipe.ingest.roots": roots.length,
        })

        const child = (
          shard: number,
          mode: IngestionShardInput["mode"],
          start: IngestionShardInput["start"],
        ): IngestionShardInput => ({
          orgId: input.orgId,
          runId: run.id,
          shard,
          mode,
          roots,
          bundle: scope.bundle,
          source,
          authorTime: input.authorTime,
          destinations,
          start,
        })

        // The repository unit, on the assembled ref and in the sandbox of
        // shard 0. Its tip is the run base of each Workspace.
        const bundle = await deps.bundle()
        if (bundle.name !== scope.bundle)
          throw new Error(
            `The ingest skill bundle changed during the run (${scope.bundle} to ${bundle.name})`,
          )
        const runtime = deps.runtime({
          orgId: input.orgId,
          runId: run.id,
          shard: 0,
          bundle,
          source,
          destinations,
        })
        const first = destinations.map(
          (d): IngestionShardWorkspace => ({
            workspaceId: d.workspaceId,
            tip: null,
            ops: 0,
            rejects: 0,
            partial: 0,
          }),
        )
        for (const skill of plannedIngestSkills(bundle.skills, "first"))
          for (const [i, destination] of destinations.entries()) {
            const state = first[i]
            if (!state) continue
            await runSkillPages({
              step: (name, fn) =>
                step.run({ name, retryPolicy: { maximumAttempts: 1 } }, () =>
                  withIngestionOrg(input.orgId, fn),
                ),
              run: {
                runId: run.id,
                shard: 0,
                bundle: scope.bundle,
                source,
                authorTime: input.authorTime,
                roots,
              },
              broker: workspaceSkillBroker({
                orgId: input.orgId,
                runId: run.id,
                source,
                destination,
                env: env(),
              }),
              runtime,
              root: null,
              skill,
              destination,
              ref: ingestRefName({
                runId: run.id,
                workspaceId: destination.workspaceId,
              }),
              runBase: destination.pinnedRevision,
              state,
            })
          }
        const runBase = Object.fromEntries(
          first.flatMap((w) =>
            w.tip ? [[w.workspaceId, { tip: w.tip, ops: w.ops }]] : [],
          ),
        )

        const shardOutputs: IngestionShardOutput[] = []
        for (let n = 0; n < shards; n += SHARD_BATCH) {
          // Wait for every child of the batch, also when one fails, so the
          // run never ends (and cleans up) while a sibling still runs.
          const settled = settledChildren(
            await Promise.allSettled(
              Array.from(
                { length: Math.min(SHARD_BATCH, shards - n) },
                (_, i) =>
                  step.runWorkflow(
                    deps.shard.spec,
                    child(n + i, "roots", runBase),
                    { name: `shard:${n + i}` },
                  ),
              ),
            ),
          )
          shardOutputs.push(...settled)
        }

        const workspaces: Extract<
          IngestionV2Output,
          { workspaces: unknown }
        >["workspaces"] = []
        for (const destination of destinations) {
          const parts = shardOutputs.flatMap((output) =>
            output.workspaces
              .filter((w) => w.workspaceId === destination.workspaceId)
              .map((w) => ({ shard: output.shard, ...w })),
          )
          const assembleStep = `assemble:${destination.workspaceId}`
          const base =
            runBase[destination.workspaceId]?.tip ?? destination.pinnedRevision
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
                      shards: parts.flatMap((p) =>
                        p.tip ? [{ shard: String(p.shard), tip: p.tip }] : [],
                      ),
                      // The shard refs start at the run base, which is
                      // the assembled ref's tip after the repository step.
                      pinnedRevision: base,
                      oldTip: runBase[destination.workspaceId]?.tip ?? null,
                      // The run cap of the Workspace counts the ops of
                      // the repository step too.
                      opsBefore: runBase[destination.workspaceId]?.ops ?? 0,
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
                        readSourceFile: (path) =>
                          ingestSourceTree({
                            orgId: input.orgId,
                            runId: run.id,
                            source: input.source,
                            sha: input.sha,
                            env: env(),
                          }).read(path),
                      },
                    },
                    env(),
                  ),
                )
                return { tip: result.sha, ops: result.ops }
              } catch (error) {
                if (!(error instanceof IngestRefRefusedError)) throw error
                logIngestEvent("warn", "ingestion-v2.partial", {
                  ingestionRunId: run.id,
                  ingestStep: assembleStep,
                  workspaceId: destination.workspaceId,
                  reason: capIngestText(error.message),
                })
                return {
                  tip: null,
                  ops: 0,
                  refused: error.message.slice(0, 300),
                }
              }
            },
          )
          const firstPart = first.find(
            (w) => w.workspaceId === destination.workspaceId,
          )
          workspaces.push({
            workspaceId: destination.workspaceId,
            assembled: assembled.tip,
            ops: assembled.ops + (firstPart?.ops ?? 0),
            rejects:
              parts.reduce((sum, p) => sum + p.rejects, 0) +
              (firstPart?.rejects ?? 0),
            // A refused assemble (also a semantic merge that fails the
            // validator) makes the Workspace `partial`.
            partial:
              parts.reduce((sum, p) => sum + p.partial, 0) +
              (firstPart?.partial ?? 0) +
              ("refused" in assembled ? 1 : 0),
            ...("refused" in assembled ? { refused: assembled.refused } : {}),
          })
        }

        const start = Object.fromEntries(
          workspaces.flatMap((w) =>
            w.assembled
              ? [[w.workspaceId, { tip: w.assembled, ops: w.ops }]]
              : [],
          ),
        )
        const ready = destinations.filter((d) => start[d.workspaceId])
        if (scope.repositorySkills > 0 && ready.length) {
          const repository = await step.runWorkflow(
            deps.shard.spec,
            {
              ...child(shards, "repository", start),
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
            // The child counts from the ops of the assembled tip.
            entry.ops = done.ops
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
        return { status: ingestionV2Status(workspaces), shards, workspaces }
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
