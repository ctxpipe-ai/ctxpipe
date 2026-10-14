import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { type Env, parseEnv } from "../../config/env.js"
import {
  IngestRefRefusedError,
  ingestRefName,
} from "../../domain/ingestion/ingest-refs.js"
import type {
  IngestDestination,
  IngestShardRuntimeFactory,
} from "../../domain/ingestion/ingest-shard-runtime.js"
import { sandboxIngestShardRuntime } from "../../domain/ingestion/ingest-shard-sandbox.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import { withIngestStepOutput } from "../../domain/ingestion/ingest-step-output.js"
import {
  type IngestSkillPlan,
  plannedIngestSkills,
  shardRoots,
  skillStepName,
} from "../../domain/ingestion/ingestion-plan.js"
import { INGESTION_SHARD_WORKFLOW_NAME } from "../../domain/ingestion/ingestion-run.js"
import {
  type IngestSkillBundle,
  readIngestSkillBundle,
} from "../../domain/ingestion/skill-bundle.js"
import {
  findWorkspaceStepCommit,
  pushWorkspaceIngestStep,
} from "../../domain/workspaces/write-broker.js"
import { createLogger, withLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * The shard child of an ingestion v2 run (ADR-052, T09). One sandbox for
 * the shard; for each root, each skill, and each destination Workspace, one
 * step that commits to the Workspace's shard ref. A `repository` child runs
 * the repository-wide skills on the assembled ref in the same way.
 *
 * Each step output holds only a ref SHA and counts. Each step is idempotent:
 * it first looks for its own commit on the ref tip (a crash after the push),
 * and the sandbox fetches the ref before it stages.
 */

const sha = z.string().regex(/^[0-9a-f]{40}$/)

export const ingestionDestinationSchema = z.object({
  workspaceId: z.string().min(1),
  url: z.string().url(),
  githubConnectionId: z.string().min(1),
  generation: z.number().int(),
  pinnedRevision: sha,
  repositoryId: z.string().nullable(),
})

export const ingestionShardInputSchema = z.object({
  orgId: z.string().min(1),
  /** The parent run: it names the refs, the sandbox, and the shard lock. */
  runId: z.string().min(1),
  shard: z.number().int().nonnegative(),
  shards: z.number().int().positive(),
  /** `roots`: the root skills of this shard; `repository`: the repository-wide skills. */
  mode: z.enum(["roots", "repository"]),
  /** The bundle name that the parent planned with. */
  bundle: z.string().min(1),
  source: z.object({
    url: z.string().url(),
    githubConnectionId: z.string().min(1),
    sha,
    repositoryId: z.string().nullable(),
  }),
  authorTime: z.string().datetime(),
  destinations: z.array(ingestionDestinationSchema).min(1),
  /** `repository` mode: the assembled tip of each Workspace. */
  startTips: z.record(z.string(), sha).optional(),
})

export type IngestionShardInput = z.infer<typeof ingestionShardInputSchema>

/** What a shard did for one Workspace. */
export type IngestionShardWorkspace = {
  workspaceId: string
  /** The ref tip after the last step; null when no step ran. */
  tip: string | null
  steps: number
  ops: number
  rejects: number
  /** Steps that failed after their retries; their root is `partial`. */
  partial: number
}

export type IngestionShardOutput = {
  shard: number
  roots: number
  workspaces: IngestionShardWorkspace[]
}

/** One step: 10 minutes and at most 2 retries (concept section 8). */
const STEP_LIMIT_MS = 10 * 60_000
const STEP_ATTEMPTS = 3

type StepResult =
  | {
      tip: string
      ops: number
      rejects: number
      resumed: boolean
      partial?: undefined
    }
  | { partial: true; reason: string }

export type IngestionV2Deps = {
  runtime: IngestShardRuntimeFactory
  bundle: () => Promise<IngestSkillBundle>
  env?: () => Env
}

export function defineIngestionShardWorkflow(deps: IngestionV2Deps) {
  const env = deps.env ?? (() => parseEnv(process.env))
  return defineWorkflow(
    {
      name: INGESTION_SHARD_WORKFLOW_NAME,
      schema: ingestionShardInputSchema,
    },
    async ({ input, step }) =>
      withLogger(
        createLogger({
          workflow: INGESTION_SHARD_WORKFLOW_NAME,
          orgId: input.orgId,
          ingestionRunId: input.runId,
          shard: input.shard,
        }),
        async (): Promise<IngestionShardOutput> => {
          const bundle = await deps.bundle()
          if (bundle.name !== input.bundle)
            throw new Error(
              `The ingest skill bundle changed during the run (${input.bundle} to ${bundle.name})`,
            )
          const runtime = deps.runtime({
            orgId: input.orgId,
            runId: input.runId,
            shard: input.shard,
            bundle,
            source: input.source,
            destinations: input.destinations,
          })
          await step.run({ name: "ensure-sandbox" }, async () => {
            await runtime.ensure()
            return { ready: true }
          })
          const roots =
            input.mode === "roots"
              ? await step.run({ name: "discover-roots" }, async () =>
                  shardRoots(
                    await runtime.discoverRoots(),
                    input.shard,
                    input.shards,
                  ),
                )
              : ["."]
          const skills = plannedIngestSkills(
            bundle.skills,
            input.mode === "roots" ? "root" : "repository",
          )
          const state = new Map(
            input.destinations.map((d) => [
              d.workspaceId,
              {
                workspaceId: d.workspaceId,
                tip: input.startTips?.[d.workspaceId] ?? null,
                steps: 0,
                ops: 0,
                rejects: 0,
                partial: 0,
              } satisfies IngestionShardWorkspace,
            ]),
          )
          for (const root of roots)
            for (const skill of skills)
              for (const destination of input.destinations) {
                const current = state.get(destination.workspaceId)
                if (!current) continue
                const name = skillStepName(
                  root,
                  skill.name,
                  destination.workspaceId,
                )
                const result = await step.run(
                  { name, retryPolicy: { maximumAttempts: 1 } },
                  (): Promise<StepResult> =>
                    runSkillStep({
                      input,
                      env: env(),
                      runtime,
                      bundle: bundle.name,
                      name,
                      root,
                      skill,
                      destination,
                      oldTip: current.tip,
                      opsBefore: current.ops,
                    }),
                )
                current.steps++
                if (result.partial) current.partial++
                else {
                  current.tip = result.tip
                  current.ops += result.ops
                  current.rejects += result.rejects
                }
              }
          await step.run({ name: "destroy-sandbox" }, async () => {
            await runtime.destroy()
            await releaseIngestSourceTree(input.runId, input.source.sha)
            return { destroyed: true }
          })
          return {
            shard: input.shard,
            roots: roots.length,
            workspaces: [...state.values()],
          }
        },
      ),
  )
}

/**
 * One skill step for one Workspace. It returns `partial` after the third
 * failed attempt, or at once when the broker refuses the job: the root keeps
 * what the earlier steps wrote, and the run goes on (no retraction).
 */
async function runSkillStep(ctx: {
  input: IngestionShardInput
  env: Env
  runtime: ReturnType<IngestShardRuntimeFactory>
  bundle: string
  name: string
  root: string
  skill: IngestSkillPlan
  destination: IngestDestination
  oldTip: string | null
  opsBefore: number
}): Promise<StepResult> {
  const { input, destination } = ctx
  const job = {
    runId: input.runId,
    workspaceId: destination.workspaceId,
    generation: destination.generation,
  }
  const ref = ingestRefName({
    runId: input.runId,
    workspaceId: destination.workspaceId,
    ...(input.mode === "roots" ? { shard: String(input.shard) } : {}),
  })
  let reason = ""
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    try {
      // A crash after the push: the step's commit is the ref tip.
      const found = await findWorkspaceStepCommit(
        { orgId: input.orgId, job, ref, step: ctx.name },
        ctx.env,
      )
      if (found) return { tip: found, ops: 0, rejects: 0, resumed: true }
      const baseCommit = ctx.oldTip ?? destination.pinnedRevision
      const tar = await ctx.runtime.runStep({
        name: ctx.name,
        skill: ctx.skill.name,
        run: ctx.skill.run,
        ...(ctx.skill.tier ? { tier: ctx.skill.tier } : {}),
        root: ctx.root,
        workspaceId: destination.workspaceId,
        baseCommit,
        ...(ctx.oldTip ? { fetchRef: ref } : {}),
        signal: AbortSignal.timeout(STEP_LIMIT_MS),
      })
      const source = ingestSourceTree({
        orgId: input.orgId,
        runId: input.runId,
        source: input.source,
        sha: input.source.sha,
        env: ctx.env,
      })
      const pushed = await withIngestStepOutput(tar, (stagedDir) =>
        pushWorkspaceIngestStep(
          {
            orgId: input.orgId,
            job,
            ref,
            oldTip: ctx.oldTip,
            pinnedRevision: destination.pinnedRevision,
            baseCommit,
            commit: {
              step: ctx.name,
              bundle: ctx.bundle,
              authorTime: new Date(input.authorTime),
            },
            patch: {
              stagedDir,
              source: { url: input.source.url, sha: input.source.sha },
              skill: ctx.skill.name,
              sourcePathExists: (path) => source.exists(path),
              workspaceOpsBefore: ctx.opsBefore,
            },
          },
          ctx.env,
        ),
      )
      return {
        tip: pushed.sha,
        ops: pushed.validation.accepted.length,
        rejects: pushed.validation.rejections.length,
        resumed: false,
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      if (error instanceof IngestRefRefusedError) break
      if (attempt < STEP_ATTEMPTS) await delay(attempt * 5_000)
    }
  }
  return { partial: true, reason: reason.slice(0, 500) }
}

let productionBundle: Promise<IngestSkillBundle> | undefined

/** The deployment's runtime: the shard sandbox and the backend image's bundle. */
export const productionIngestionV2Deps: IngestionV2Deps = {
  runtime: sandboxIngestShardRuntime,
  bundle: () => {
    productionBundle ??= readIngestSkillBundle()
    productionBundle.catch(() => {
      productionBundle = undefined
    })
    return productionBundle
  },
}

export const ingestionShard = defineIngestionShardWorkflow(
  productionIngestionV2Deps,
)
