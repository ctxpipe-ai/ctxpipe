import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { type Env, parseEnv } from "../../config/env.js"
import {
  IngestRefRefusedError,
  ingestRefName,
} from "../../domain/ingestion/ingest-refs.js"
import { ingestStepSignal } from "../../domain/ingestion/ingest-shard-ops.js"
import type {
  IngestDestination,
  IngestShardRuntime,
  IngestShardRuntimeFactory,
} from "../../domain/ingestion/ingest-shard-runtime.js"
import { sandboxIngestShardRuntime } from "../../domain/ingestion/ingest-shard-sandbox.js"
import { ingestSourceTree } from "../../domain/ingestion/ingest-source-tree.js"
import { withIngestStepOutput } from "../../domain/ingestion/ingest-step-output.js"
import {
  type IngestSkillPlan,
  ingestRootMap,
  plannedIngestSkills,
  skillStepName,
} from "../../domain/ingestion/ingestion-plan.js"
import { INGESTION_SHARD_WORKFLOW_NAME } from "../../domain/ingestion/ingestion-run.js"
import { withIngestionOrg } from "../../domain/ingestion/ingestion-v2-resolve.js"
import {
  type IngestSkillBundle,
  readIngestSkillBundle,
} from "../../domain/ingestion/skill-bundle.js"
import {
  findWorkspaceStepCommit,
  listWorkspaceIngestStepFiles,
  pushWorkspaceIngestStep,
} from "../../domain/workspaces/write-broker.js"
import {
  createLogger,
  getLogger,
  withLogger,
} from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * The shard child of an ingestion v2 run (ADR-052, T09). One sandbox for
 * the shard; for each root of the shard's explicit list, each skill, and
 * each destination Workspace, one step that commits to the Workspace's shard
 * ref. A `repository` child runs the repository-wide skills on the assembled
 * ref in the same way; a script skill runs again while it says `more`.
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

/** A planned root, as `resolveDiscoveredRoots` gave it. */
export const ingestionRootSchema = z.object({
  path: z.string().min(1).max(300),
  manifests: z.array(z.string()),
  evidence: z.array(z.string()),
})

export const ingestionShardInputSchema = z.object({
  orgId: z.string().min(1),
  /** The parent run: it names the refs, the sandbox, and the shard lock. */
  runId: z.string().min(1),
  shard: z.number().int().nonnegative(),
  /**
   * `roots`: the root skills on this shard's roots; `repository`: the
   * repository-wide skills, with every root of the run for the root map.
   */
  mode: z.enum(["roots", "repository"]),
  roots: z.array(ingestionRootSchema),
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
export type IngestionRoot = z.infer<typeof ingestionRootSchema>

/** What a shard did for one Workspace. */
export type IngestionShardWorkspace = {
  workspaceId: string
  /** The ref tip after the last step; null when no step ran. */
  tip: string | null
  ops: number
  rejects: number
  /** Steps that failed after their retries; their root is `partial`. */
  partial: number
}

export type IngestionShardOutput = {
  shard: number
  workspaces: IngestionShardWorkspace[]
}

/** At most 2 retries for each step (concept section 8). */
const STEP_ATTEMPTS = 3
/** A script skill runs at most this many pages; then it is `partial`. */
const MAX_SCRIPT_PAGES = 20

type StepResult =
  | {
      tip: string
      ops: number
      rejects: number
      more: boolean
      partial?: undefined
    }
  | { partial: true }

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
          // Each step makes the sandbox again when it is gone. This step
          // makes a provider that cannot start fail the child at once.
          await step.run({ name: "ensure-sandbox" }, async () => {
            await runtime.ensure()
            return { ready: true }
          })
          const repository = input.mode === "repository"
          const skills = plannedIngestSkills(
            bundle.skills,
            repository ? "repository" : "root",
          )
          const state = new Map(
            input.destinations.map((d) => [
              d.workspaceId,
              {
                workspaceId: d.workspaceId,
                tip: input.startTips?.[d.workspaceId] ?? null,
                ops: 0,
                rejects: 0,
                partial: 0,
              } satisfies IngestionShardWorkspace,
            ]),
          )
          const runOne = async (
            root: string | null,
            skill: IngestSkillPlan,
            destination: IngestDestination,
          ) => {
            const current = state.get(destination.workspaceId)
            if (!current) return
            const pages = skill.run === "script" ? MAX_SCRIPT_PAGES : 1
            for (let page = 1; page <= pages; page++) {
              const name = skillStepName(
                root,
                skill.name,
                destination.workspaceId,
                page,
              )
              const result = await step.run(
                { name, retryPolicy: { maximumAttempts: 1 } },
                (): Promise<StepResult> =>
                  withIngestionOrg(input.orgId, () =>
                    runSkillStep({
                      input,
                      env: env(),
                      runtime,
                      bundle: bundle.name,
                      name,
                      root: root ?? ".",
                      skill,
                      destination,
                      oldTip: current.tip,
                      opsBefore: current.ops,
                    }),
                  ),
              )
              if (result.partial) {
                current.partial++
                return
              }
              current.tip = result.tip
              current.ops += result.ops
              current.rejects += result.rejects
              if (!result.more) return
            }
            current.partial++
            getLogger().warn("ingestion-v2.step-partial", {
              step: skillStepName(root, skill.name, destination.workspaceId),
              reason: `The script still had files after ${MAX_SCRIPT_PAGES} pages`,
            })
          }
          const roots = repository ? [null] : input.roots.map((r) => r.path)
          for (const root of roots)
            for (const skill of skills)
              for (const destination of input.destinations)
                await runOne(root, skill, destination)
          await step.run({ name: "destroy-sandbox" }, async () => {
            await deps.runtime.destroy({
              orgId: input.orgId,
              runId: input.runId,
              shard: input.shard,
              workspaceId: input.destinations[0]?.workspaceId ?? "",
            })
            return { destroyed: true }
          })
          return { shard: input.shard, workspaces: [...state.values()] }
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
  runtime: IngestShardRuntime
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
      // A crash after the push: the step's commit is the ref tip. A page
      // that wrote files may have a next page; one more page finds none.
      const found = await findWorkspaceStepCommit(
        { orgId: input.orgId, job, ref, step: ctx.name },
        ctx.env,
      )
      if (found)
        return {
          tip: found.sha,
          ops: found.ops,
          rejects: 0,
          more: ctx.skill.run === "script" && found.ops > 0,
        }
      const baseCommit = ctx.oldTip ?? destination.pinnedRevision
      const rootMap =
        input.mode === "repository" && ctx.skill.run === "script"
          ? ingestRootMap(
              input.roots,
              await listWorkspaceIngestStepFiles(
                {
                  orgId: input.orgId,
                  job,
                  pinnedRevision: destination.pinnedRevision,
                  tip: baseCommit,
                },
                ctx.env,
              ),
            )
          : undefined
      const { tar, more } = await ctx.runtime.runStep({
        name: ctx.name,
        skill: ctx.skill.name,
        run: ctx.skill.run,
        ...(ctx.skill.tier ? { tier: ctx.skill.tier } : {}),
        root: ctx.root,
        workspaceId: destination.workspaceId,
        baseCommit,
        ...(ctx.oldTip ? { fetchRef: ref } : {}),
        ...(rootMap ? { rootMap } : {}),
        signal: ingestStepSignal(),
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
      // T11 reads the rejected ops from the logs; the step output keeps counts.
      for (const rejection of pushed.validation.rejections)
        getLogger().warn("ingestion-v2.op-rejected", {
          step: ctx.name,
          workspaceId: destination.workspaceId,
          rule: rejection.rule,
          path: rejection.path,
          reason: rejection.reason,
        })
      return {
        tip: pushed.sha,
        ops: pushed.validation.accepted.length,
        rejects: pushed.validation.rejections.length,
        more,
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      if (error instanceof IngestRefRefusedError) break
      if (attempt < STEP_ATTEMPTS) await delay(attempt * 5_000)
    }
  }
  getLogger().warn("ingestion-v2.step-partial", {
    step: ctx.name,
    workspaceId: destination.workspaceId,
    reason: reason.slice(0, 2_000),
  })
  return { partial: true }
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
