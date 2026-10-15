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
import {
  resolveIngestConflicts,
  SemanticResolveError,
} from "../../domain/workspaces/semantic-merge.js"
import {
  deleteWorkspaceIngestRefs,
  pushWorkspaceIngestAssemble,
} from "../../domain/workspaces/write-broker.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
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
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"
import { migrateOwnershipBeforePublish } from "./workspace-ownership-migration.js"

/*
 * The ingestion v2 parent workflow (ADR-052, T09 and T21):
 *
 *   resolve -> index -> discover-roots -> skill:repository:repository
 *   -> shard:<n> (children) -> assemble:<workspaceId>
 *   -> repository-skills (child) -> release
 *   -> publish:<workspaceId> (child) -> delete-refs:<workspaceId>
 *
 * `discover-roots` runs once, in the sandbox of shard 0, and the host check
 * (`resolveDiscoveredRoots`) plans the roots. Each shard gets its explicit
 * root list. Step outputs hold ref SHAs and counts; the one larger output is
 * the compressed root list, which the root cap keeps far below 16 KB.
 * The `repository` skill runs in the parent, in the sandbox of shard 0, and
 * writes the repository unit on the assembled ref. Its tip is the run base
 * of each Workspace: the shard refs start there, and `assemble` merges the
 * shard tips against it (ADR-052 section 6).
 * A shadow run (`shadow` in the input) publishes nothing: the refs stay for
 * the comparison (T20). Another run gives each assembled tip to
 * `workspace-write-extract-ingest`, which replays the delta from the pinned
 * revision on the current default tip as one commit. A path that a person
 * also changed after the pin goes through the semantic merge and the patch
 * validator; a rejected merge publishes nothing and makes the Workspace
 * `partial`. A `partial` Workspace publishes its accepted ops, but the
 * deletes of a failed root stay out: a failed root gets no retraction. A
 * refused assemble publishes the run base; so does an assemble whose merge
 * model fails. A publish that fails (the merge model fails, or the default
 * branch wins each push race) also makes the Workspace `partial`, and the
 * other Workspaces publish. Then `delete-refs` deletes the run's refs, but
 * not the refs of a Workspace whose merge model or publish failed. The tip check deletes the refs that stay (the run is then
 * finished and not a shadow run). A run outside shadow mode first runs
 * the ownership migration in each destination
 * (`ownership-migration:<workspaceId>`).
 */

/** The write job of the publish of one Workspace; a replay finds it. */
export function ingestPublishJobId(runId: string, workspaceId: string): string {
  return `wjob_${runId}_publish_${workspaceId}`
}

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
        /** The commit on the default branch; null for no change. */
        published?: string | null
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
        if (!input.shadow && input.publishPipeline !== "v2")
          // Only a run while the switch is v2 may take files over from the
          // old pipeline and publish.
          throw new Error(
            "Ingestion v2 runs outside shadow mode only while the publish pipeline is v2",
          )

        let resolved = await step.run({ name: "resolve" }, () =>
          resolveIngestionV2Run(input),
        )
        // Before the first v2 publish to a Workspace, its old extracted files
        // move to ingestion v2 ownership (ADR-052 section 3). Then the run
        // reads the new revisions.
        // A Workspace whose migration fails is `partial`: it publishes
        // nothing and keeps its refs, and the other Workspaces go on.
        let migrationFailed = new Set<string>()
        if (!input.shadow && !resolved.skipped) {
          const migration = await migrateOwnershipBeforePublish({
            publishPipeline: input.publishPipeline,
            step,
            orgId: input.orgId,
            runId: run.id,
            workspaceIds: resolved.destinations.map((d) => d.workspaceId),
            env: env(),
          })
          migrationFailed = new Set(migration.failed)
          if (migration.committed)
            resolved = await step.run({ name: "resolve-migrated" }, () =>
              resolveIngestionV2Run(input),
            )
        }
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
            partialRoots: [],
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

        /**
         * The Workspaces whose merge model failed (at assemble or publish),
         * or whose publish lost each push race: their refs stay for the
         * tip check.
         */
        const keepRefs = new Set<string>()
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
              | { tip: null; ops: 0; refused: string; keepRefs?: true }
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
                        resolve: resolveIngestConflicts,
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
                // A failed merge model is a refused assemble too, but the
                // run keeps the refs of the Workspace.
                const failed = error instanceof SemanticResolveError
                if (!(error instanceof IngestRefRefusedError) && !failed)
                  throw error
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
                  ...(failed ? { keepRefs: true as const } : {}),
                }
              }
            },
          )
          if ("keepRefs" in assembled) keepRefs.add(destination.workspaceId)
          const firstPart = first.find(
            (w) => w.workspaceId === destination.workspaceId,
          )
          workspaces.push({
            workspaceId: destination.workspaceId,
            // A refused assemble drops the shards' ops. The run base (the
            // repository step's ops) is still accepted, so it publishes.
            assembled:
              assembled.tip ?? runBase[destination.workspaceId]?.tip ?? null,
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

        if (!input.shadow)
          for (const destination of destinations) {
            const { workspaceId } = destination
            const entry = workspaces.find((w) => w.workspaceId === workspaceId)
            if (entry && migrationFailed.has(workspaceId)) {
              entry.published = null
              entry.refused = "The ownership migration failed"
              entry.partial += 1
              keepRefs.add(workspaceId)
              getLogger().warn("ingestion-v2.partial", {
                ingestionRunId: run.id,
                step: `ownership-migration:${workspaceId}`,
                workspaceId,
                reason: "ownership_migration_failed",
              })
            } else if (entry?.assembled) {
              const assembled = entry.assembled
              const revision = await step.run(
                { name: `publish-revision:${workspaceId}` },
                () =>
                  withIngestionOrg(input.orgId, async () => {
                    const admission = await getWorkspaceWriteAdmission(
                      workspaceId,
                      input.orgId,
                    )
                    // The pinned revision belongs to the binding that
                    // `resolve` read. A relink publishes nothing.
                    if (
                      admission?.revision.generation !== destination.generation
                    )
                      return null
                    return {
                      ...admission.revision,
                      sha: destination.pinnedRevision,
                    }
                  }),
              )
              if (revision) {
                const published = await step.runWorkflow(
                  workspaceExtractIngest.spec,
                  {
                    orgId: input.orgId,
                    workspaceId,
                    jobId: ingestPublishJobId(run.id, workspaceId),
                    revision,
                    publishPipeline: input.publishPipeline,
                    ingest: {
                      runId: run.id,
                      tip: assembled,
                      // Only a failed root keeps its files (no retraction).
                      withheldRoots: [
                        ...new Set(
                          shardOutputs.flatMap((output) =>
                            output.workspaces
                              .filter((w) => w.workspaceId === workspaceId)
                              .flatMap((w) => w.partialRoots),
                          ),
                        ),
                      ].sort(),
                      bundle: scope.bundle,
                      source: input.source,
                      sourceSha: input.sha,
                      authorTime: input.authorTime,
                    },
                  },
                  { name: `publish:${workspaceId}` },
                )
                entry.published = published.committed
                  ? published.commitSha
                  : null
                if (!published.committed && published.reason === "failed")
                  keepRefs.add(workspaceId)
                if (
                  !published.committed &&
                  (published.reason === "refused" ||
                    published.reason === "failed")
                ) {
                  entry.refused =
                    published.reason === "refused"
                      ? published.refused
                      : published.failed
                  entry.partial += 1
                  getLogger().warn("ingestion-v2.partial", {
                    ingestionRunId: run.id,
                    step: `publish:${workspaceId}`,
                    workspaceId,
                    // A fixed code: the cause text can hold model or customer text.
                    reason: published.reason,
                  })
                }
              } else {
                entry.refused = "The Workspace binding changed before publish"
                entry.partial += 1
                getLogger().warn("ingestion-v2.partial", {
                  ingestionRunId: run.id,
                  step: `publish:${workspaceId}`,
                  workspaceId,
                  reason: entry.refused,
                })
              }
            }
          }
        // Each Workspace publishes first, so a failed delete stops no
        // publish.
        if (!input.shadow)
          for (const { workspaceId, generation } of destinations.filter(
            (d) => !keepRefs.has(d.workspaceId),
          ))
            await step.run(
              {
                name: `delete-refs:${workspaceId}`,
                retryPolicy: { maximumAttempts: 3, initialInterval: "10s" },
              },
              async () => {
                try {
                  const deleted = await withIngestionOrg(input.orgId, () =>
                    deleteWorkspaceIngestRefs(
                      {
                        orgId: input.orgId,
                        job: {
                          runId: run.id,
                          workspaceId,
                          generation,
                        },
                      },
                      env(),
                    ),
                  )
                  return { deleted: deleted.length }
                } catch (error) {
                  // A Workspace that is not writable now, or was relinked:
                  // the tip check deletes the refs later.
                  if (!(error instanceof IngestRefRefusedError)) throw error
                  getLogger().warn("ingestion-v2.delete-refs-refused", {
                    workspaceId,
                    reason: error.message,
                  })
                  return { deleted: 0 }
                }
              },
            )

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
