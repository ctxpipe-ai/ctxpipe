import type { Attributes } from "@opentelemetry/api"
import type { Workflow } from "openworkflow"

import { parseEnv } from "../../config/env.js"
import {
  collectRepositoryCheckouts,
  releaseRunCheckout,
} from "../../domain/codesearchCheckoutGc.js"
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
  packRoots,
  planIngestRoots,
  plannedIngestSkills,
  unpackRoots,
} from "../../domain/ingestion/ingestion-plan.js"
import {
  INGESTION_V2_WORKFLOW_NAME,
  ingestionV2InputSchema,
  ingestionV2Status,
} from "../../domain/ingestion/ingestion-run.js"
import { workspacePublishPipeline } from "../../domain/ingestion/ingestion-v2-config.js"
import {
  resolveIngestionV2Run,
  withIngestionOrg,
} from "../../domain/ingestion/ingestion-v2-resolve.js"
import {
  ingestPublishTurn,
  waitForPublishTurn,
} from "../../domain/ingestion/publish-turn.js"
import {
  resolveIngestConflicts,
  SemanticResolveError,
} from "../../domain/workspaces/semantic-merge.js"
import { readWorkspaceFormatAt } from "../../domain/workspaces/workspace-format-tree.js"
import {
  deleteWorkspaceIngestRefs,
  pushWorkspaceIngestAssemble,
  readWorkspaceIngestRunTip,
} from "../../domain/workspaces/write-broker.js"
import { getWorkspaceWriteAdmission } from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import { withCrashLoopGuard } from "../crash-loop.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { cleanUpUnlessParked, settledChildren } from "../isSleepSignal.js"
import {
  addStepFailures,
  guardedSkillStep,
  type IngestionShardInput,
  type IngestionShardOutput,
  type IngestionShardWorkspace,
  type IngestionV2Deps,
  type IngestStepFailures,
  ingestionShard,
  productionIngestionV2Deps,
  runSkillPages,
  workspaceSkillBroker,
} from "./ingestion-shard.js"
import { repositoryIndex } from "./repository-index.js"
import { workspaceExtractIngest } from "./workspace-extract-ingest.js"

/*
 * The ingestion v2 parent workflow (ADR-052, T09 and T21):
 *
 *   publish-turn:<n> -> resolve -> index -> discover-roots
 *   -> skill:repository:repository
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
 * finished and not a shadow run). A run outside shadow mode publishes only
 * to a Workspace whose tree at the pinned revision is at format 3 or more
 * (G5). Upgrade step 3 moved the old extracted files of that tree to
 * ingestion v2 ownership.
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
        /** The steps that failed after their retries, by cause (CTX-896). */
        stepFailures?: IngestStepFailures
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
      logFields: (input, run) => ({
        orgId: input.orgId,
        ingestionRunId: run.id,
        sourceSha: input.sha,
      }),
      name: INGESTION_V2_WORKFLOW_NAME,
      schema: ingestionV2InputSchema,
    },
    async ({ input, step, run }) => {
      // A failed run also deletes the worker's copy of the source tree,
      // and the index repositories of its repository step (shard 0). Each
      // run that ends deletes its codesearch checkout, unless it is the
      // published revision.
      return cleanUpUnlessParked(
        () => ingestWithSpan(),
        async () => {
          await releaseIngestSourceTree(run.id, input.sha)
          await releaseIngestStepIndexes(run.id, 0)
          await releaseRunCheckout({
            orgId: input.orgId,
            sha: input.sha,
            runId: run.id,
          })
        },
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
        // Pin after an earlier run of this source publishes to the same
        // Workspace (CTX-895), so the two publishes do not race. After 60
        // minutes of wall time the run goes on: the merge model then joins
        // the two (CTX-964).
        if (!input.shadow) {
          const wait = await waitForPublishTurn({
            step,
            startedAt: run.startedAt,
            check: () =>
              ingestPublishTurn({
                orgId: input.orgId,
                runId: run.id,
                sourceUrl: input.source.url,
                destinations: input.destinations,
              }),
          })
          attributes["ctxpipe.ingest.wait.outcome"] = wait.outcome
          attributes["ctxpipe.ingest.wait.checks"] = wait.checks
          if (wait.outcome === "deadline")
            logIngestEvent("warn", "ingestion-v2.wait-deadline", {
              ingestionRunId: run.id,
              reason:
                "An earlier run of this source did not finish in 60 minutes, so this run goes on and the merge model joins the two publishes",
            })
        }
        const resolved = await step.run({ name: "resolve" }, () =>
          resolveIngestionV2Run(input),
        )
        if (!resolved.skipped)
          for (const workspaceId of resolved.needsUpgrade)
            logIngestEvent("warn", "ingestion-v2.upgrade-needed", {
              ingestionRunId: run.id,
              workspaceId,
              reason:
                "The Workspace is below format 3, so the run does not publish to it",
            })
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
              // A plain git source has no connection; codesearch reads it
              // with no credential, as on main (CTX-815).
              ...(input.source.kind !== "git"
                ? { githubConnectionId: input.source.githubConnectionId }
                : {}),
              ingestionV2: true,
            },
            { name: "index" },
          )
        // The index published a new revision: delete the checkouts that no
        // reader needs any more (CTX-973). It never throws.
        if (sourceRepositoryId)
          await step.run({ name: "collect-old-checkouts" }, () =>
            collectRepositoryCheckouts({
              orgId: input.orgId,
              repositoryId: sourceRepositoryId,
              // Three batches: the hourly job finishes the rest.
              maxBatches: 3,
            }),
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

        // A crash loop ends the run `partial` with the cause and the fix. A
        // throw would make OpenWorkflow retry the step 10 times (CTX-971).
        const scope = await step.run({ name: "discover-roots" }, () =>
          withCrashLoopGuard(
            run.id,
            "discover-roots",
            async (): Promise<
              | { partial: string }
              | {
                  partial?: undefined
                  bundle: string
                  roots: string
                  repositorySkills: number
                }
            > => {
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
              const packed =
                plan.partial === undefined ? packRoots(plan.roots) : ""
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
                repositorySkills: plannedIngestSkills(
                  bundle.skills,
                  "repository",
                ).length,
              }
            },
            (error) => ({ partial: error.message }),
          ),
        )
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
        const first = destinations.map((d): IngestionShardWorkspace => ({
          workspaceId: d.workspaceId,
          tip: null,
          ops: 0,
          rejects: 0,
          partial: 0,
          partialRoots: [],
        }))
        for (const skill of plannedIngestSkills(bundle.skills, "first"))
          for (const [i, destination] of destinations.entries()) {
            const state = first[i]
            if (!state) continue
            await runSkillPages({
              step: guardedSkillStep(step, run.id, input.orgId),
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
                      // Each shard, also one whose output has no tip:
                      // assemble takes the tips from the shard refs, which
                      // another execution of a child can move (CTX-1073).
                      shards: parts.map((p) => ({
                        shard: String(p.shard),
                        tip: p.tip,
                      })),
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
                        sourcePath: destination.sourcePath,
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
            stepFailures: addStepFailures(
              ...parts.map((p) => p.stepFailures),
              firstPart?.stepFailures,
            ),
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
            entry.stepFailures = addStepFailures(
              entry.stepFailures,
              done.stepFailures,
            )
          }
        }

        await release()

        if (!input.shadow)
          for (const destination of destinations) {
            const { workspaceId } = destination
            const entry = workspaces.find((w) => w.workspaceId === workspaceId)
            if (entry?.assembled) {
              const given = entry.assembled
              const target = await step.run(
                { name: `publish-target:${workspaceId}` },
                async () => {
                  const admission = await withIngestionOrg(input.orgId, () =>
                    getWorkspaceWriteAdmission(workspaceId, input.orgId),
                  )
                  // The pinned revision belongs to the binding that
                  // `resolve` read. A relink publishes nothing.
                  if (admission?.revision.generation !== destination.generation)
                    return { skip: "relinked" as const }
                  const pinned = {
                    ...admission.revision,
                    sha: destination.pinnedRevision,
                  }
                  // `resolve` read the cached format of the active
                  // projection. The pinned tree decides (G5): a revert of the
                  // upgrade before hydrate gives a tree below format 3.
                  const format = await readWorkspaceFormatAt({
                    orgId: input.orgId,
                    env: env(),
                    revision: pinned,
                  })
                  if (workspacePublishPipeline(format) !== "v2")
                    return { skip: "below_format" as const }
                  return { revision: pinned }
                },
              )
              const revision = "revision" in target ? target.revision : null
              if (revision) {
                // Another execution of the repository child can push after
                // its output took the tip (CTX-1073). Publish takes the ref's
                // tip, so it keeps those commits. A refused read keeps the
                // output's tip, which is a commit of the run.
                const assembled = await step.run(
                  { name: `publish-tip:${workspaceId}` },
                  () =>
                    withIngestionOrg(input.orgId, () =>
                      readWorkspaceIngestRunTip(
                        {
                          orgId: input.orgId,
                          job: {
                            runId: run.id,
                            workspaceId,
                            generation: destination.generation,
                          },
                          ref: ingestRefName({ runId: run.id, workspaceId }),
                          given,
                        },
                        env(),
                      ),
                    ).catch((error: unknown) => {
                      if (!(error instanceof IngestRefRefusedError)) throw error
                      logIngestEvent("warn", "ingestion-v2.publish-tip-kept", {
                        ingestionRunId: run.id,
                        workspaceId,
                        reason: capIngestText(error.message),
                      })
                      return given
                    }),
                )
                entry.assembled = assembled
                const published = await step.runWorkflow(
                  workspaceExtractIngest.spec,
                  {
                    orgId: input.orgId,
                    workspaceId,
                    jobId: ingestPublishJobId(run.id, workspaceId),
                    revision,
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
                      sourcePath: destination.sourcePath,
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
              } else if ("skip" in target && target.skip === "below_format") {
                entry.published = null
                logIngestEvent("warn", "ingestion-v2.upgrade-needed", {
                  ingestionRunId: run.id,
                  workspaceId,
                  reason:
                    "The pinned revision is below format 3, so the run does not publish to it",
                })
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

export const repositoryIngestionV2 = defineRepositoryIngestionV2Workflow({
  ...productionIngestionV2Deps,
  shard: ingestionShard,
})
