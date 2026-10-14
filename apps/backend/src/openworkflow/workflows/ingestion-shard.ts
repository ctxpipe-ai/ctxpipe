import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { type Env, parseEnv } from "../../config/env.js"
import {
  IngestRefRefusedError,
  ingestRefName,
  type PushIngestStepInput,
} from "../../domain/ingestion/ingest-refs.js"
import { ingestStepSignal } from "../../domain/ingestion/ingest-shard-ops.js"
import type {
  IngestDestination,
  IngestShardRuntime,
  IngestShardRuntimeFactory,
} from "../../domain/ingestion/ingest-shard-runtime.js"
import {
  releaseIngestStepIndexes,
  sandboxIngestShardRuntime,
} from "../../domain/ingestion/ingest-shard-sandbox.js"
import {
  ingestSourceTree,
  releaseIngestSourceTree,
} from "../../domain/ingestion/ingest-source-tree.js"
import { withIngestStepOutput } from "../../domain/ingestion/ingest-step-output.js"
import {
  INGEST_SHARD_MAX_ROOTS,
  type IngestSkillPlan,
  ingestRootMap,
  plannedIngestSkills,
  skillStepName,
} from "../../domain/ingestion/ingestion-plan.js"
import { INGESTION_SHARD_WORKFLOW_NAME } from "../../domain/ingestion/ingestion-run.js"
import { withIngestionOrg } from "../../domain/ingestion/ingestion-v2-resolve.js"
import type { PatchStepResult } from "../../domain/ingestion/patch-validator.js"
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
import { cleanUpUnlessParked } from "../isSleepSignal.js"

/*
 * The shard child of an ingestion v2 run (ADR-052, T09). One sandbox for
 * the shard; for each root of the shard's explicit list, each skill, and
 * each destination Workspace, one step that commits to the Workspace's shard
 * ref. A `repository` child runs the repository-wide skills on the
 * assembled ref after `assemble`. A skill runs again on the new tip while
 * its `patch.json` says `more` (ADR-052 section 6). The parent runs the
 * `repository` skill itself, with `runSkillPages`, before the shards.
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
   * `roots`: the root skills on the roots of this shard; `repository`: the
   * repository-wide skills on the assembled ref, after `assemble`.
   */
  mode: z.enum(["roots", "repository"]),
  /**
   * Every root of the run, for the root-to-file map. A `roots` shard takes
   * its part of the list by its number.
   */
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
  /**
   * Where each Workspace starts: the tip of its assembled ref (the run base
   * in `roots` mode, the assembled tip in `repository` mode) and the ops
   * that the run wrote there. A Workspace with no entry starts at its pinned
   * revision with no ops.
   */
  start: z.record(
    z.string(),
    z.object({ tip: sha, ops: z.number().int().nonnegative() }),
  ),
})

export type IngestionShardInput = z.infer<typeof ingestionShardInputSchema>
export type IngestionRoot = z.infer<typeof ingestionRootSchema>

/** What a shard did for one Workspace. */
export type IngestionShardWorkspace = {
  workspaceId: string
  /** The ref tip after the last step; null when no step ran. */
  tip: string | null
  /** The accepted ops of the run in this Workspace, up to the last step. */
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
/** A skill runs at most this many pages; then it is `partial` (ADR-052 section 6). */
export const INGEST_MAX_PAGES = 20

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

/** The holder of a shard child's own copy of the source tree. */
export function shardTreeHolder(
  input: Pick<IngestionShardInput, "shard" | "mode">,
): string {
  return `${input.mode}:${input.shard}`
}

/** The roots that a `roots` shard runs: its part of the run's list. */
export function shardRoots(
  roots: readonly IngestionRoot[],
  shard: number,
): IngestionRoot[] {
  return roots.slice(
    shard * INGEST_SHARD_MAX_ROOTS,
    (shard + 1) * INGEST_SHARD_MAX_ROOTS,
  )
}

export function defineIngestionShardWorkflow(deps: IngestionV2Deps) {
  const env = deps.env ?? (() => parseEnv(process.env))
  return defineWorkflow(
    {
      name: INGESTION_SHARD_WORKFLOW_NAME,
      schema: ingestionShardInputSchema,
    },
    async ({ input, step }) => {
      const runShard = async (): Promise<IngestionShardOutput> => {
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
        // makes a provider that cannot start fail the child soon.
        await step.run(
          { name: "ensure-sandbox", retryPolicy: { maximumAttempts: 2 } },
          async () => {
            await runtime.ensure()
            return { ready: true }
          },
        )
        const skills = plannedIngestSkills(
          bundle.skills,
          input.mode === "roots" ? "root" : "repository",
        )
        // A `roots` shard ref starts at the run base; the `repository`
        // steps go on from the assembled tip.
        const state = new Map(
          input.destinations.map((d) => {
            const start = input.start[d.workspaceId]
            return [
              d.workspaceId,
              {
                workspaceId: d.workspaceId,
                tip: input.mode === "repository" ? (start?.tip ?? null) : null,
                ops: start?.ops ?? 0,
                rejects: 0,
                partial: 0,
              } satisfies IngestionShardWorkspace,
            ]
          }),
        )
        const roots =
          input.mode === "roots"
            ? shardRoots(input.roots, input.shard).map((r) => r.path)
            : [null]
        for (const root of roots)
          for (const skill of skills)
            for (const destination of input.destinations) {
              const current = state.get(destination.workspaceId)
              if (!current) continue
              await runSkillPages({
                step: (name, fn) =>
                  step.run({ name, retryPolicy: { maximumAttempts: 1 } }, () =>
                    withIngestionOrg(input.orgId, fn),
                  ),
                run: input,
                broker: workspaceSkillBroker({
                  orgId: input.orgId,
                  runId: input.runId,
                  source: input.source,
                  destination,
                  env: env(),
                  holder: shardTreeHolder(input),
                }),
                runtime,
                root,
                skill,
                destination,
                ref: ingestRefName({
                  runId: input.runId,
                  workspaceId: destination.workspaceId,
                  ...(input.mode === "roots"
                    ? { shard: String(input.shard) }
                    : {}),
                }),
                runBase:
                  input.start[destination.workspaceId]?.tip ??
                  destination.pinnedRevision,
                state: current,
              })
            }
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
      }
      return withLogger(
        createLogger({
          workflow: INGESTION_SHARD_WORKFLOW_NAME,
          orgId: input.orgId,
          ingestionRunId: input.runId,
          shard: input.shard,
        }),
        // The child's own copy of the source tree and its index
        // repositories go when the child ends, also when it fails. A sibling
        // child has its own copies.
        () =>
          cleanUpUnlessParked(runShard, async () => {
            await releaseIngestSourceTree(
              input.runId,
              input.source.sha,
              shardTreeHolder(input),
            )
            await releaseIngestStepIndexes(input.runId, input.shard)
          }),
      )
    },
  )
}

/** The run fields that a skill step reads. */
type SkillRun = Pick<
  IngestionShardInput,
  "runId" | "bundle" | "source" | "authorTime" | "roots"
>

/**
 * The ref jobs of one skill step for one Workspace. In production it is the
 * write broker (`workspaceSkillBroker`); a contract test gives a local remote.
 */
export type SkillStepBroker = {
  /** The step's commit on the ref tip after a crash after the push, or null. */
  find(
    ref: string,
    step: string,
  ): Promise<{
    sha: string
    ops: number
    more: boolean
  } | null>
  /** The files of each step commit from the pinned revision to `tip`. */
  listFiles(
    pinnedRevision: string,
    tip: string,
  ): Promise<Array<{ step: string; paths: string[] }>>
  push(
    input: Omit<PushIngestStepInput, "remote" | "job">,
  ): Promise<{ sha: string; validation: PatchStepResult; more: boolean }>
  /** True when `path` exists in the source at the run's SHA. */
  sourcePathExists(path: string): Promise<boolean>
}

/** The write broker of one Workspace, with the source tree of `holder`. */
export function workspaceSkillBroker(input: {
  orgId: string
  runId: string
  source: IngestionShardInput["source"]
  destination: IngestDestination
  env: Env
  /** The holder of the source tree copy; the parent has none. */
  holder?: string
}): SkillStepBroker {
  const job = {
    runId: input.runId,
    workspaceId: input.destination.workspaceId,
    generation: input.destination.generation,
  }
  const source = ingestSourceTree({
    orgId: input.orgId,
    runId: input.runId,
    source: input.source,
    sha: input.source.sha,
    env: input.env,
    ...(input.holder ? { holder: input.holder } : {}),
  })
  return {
    find: (ref, step) =>
      findWorkspaceStepCommit(
        { orgId: input.orgId, job, ref, step },
        input.env,
      ),
    listFiles: (pinnedRevision, tip) =>
      listWorkspaceIngestStepFiles(
        { orgId: input.orgId, job, pinnedRevision, tip },
        input.env,
      ),
    push: (push) =>
      pushWorkspaceIngestStep({ ...push, orgId: input.orgId, job }, input.env),
    sourcePathExists: (path) => source.exists(path),
  }
}

type SkillPages = {
  /** One workflow step: `step.run` with no OpenWorkflow retry. */
  step: (name: string, fn: () => Promise<StepResult>) => Promise<StepResult>
  run: SkillRun
  broker: SkillStepBroker
  runtime: IngestShardRuntime
  /** The root of a root step; null for a repository-wide step. */
  root: string | null
  skill: IngestSkillPlan
  destination: IngestDestination
  /** The ref that the steps commit to. */
  ref: string
  /**
   * The first commit of the ref when the ref is new: the run base for a
   * shard ref (on the assembled ref), the pinned revision otherwise.
   */
  runBase: string
  /** The Workspace's tip and counts; each page adds to them. */
  state: IngestionShardWorkspace
}

/**
 * The pages of one skill for one Workspace (ADR-052 section 6): the host runs
 * the skill again on the new tip while its `patch.json` says `more`, for at
 * most 20 pages. A page that accepts no op stops the skill: the next page
 * would start from the same tip. Each step counts against the run cap of
 * the Workspace (`state.ops`, from the start of the run).
 */
export async function runSkillPages(ctx: SkillPages): Promise<void> {
  const { state } = ctx
  const label = skillStepName(
    ctx.root,
    ctx.skill.name,
    ctx.destination.workspaceId,
  )
  for (let page = 1; page <= INGEST_MAX_PAGES; page++) {
    const name = skillStepName(
      ctx.root,
      ctx.skill.name,
      ctx.destination.workspaceId,
      page,
    )
    const oldTip = state.tip
    const opsBefore = state.ops
    const result = await ctx.step(name, () =>
      runSkillStep({ ...ctx, name, oldTip, opsBefore }),
    )
    if (result.partial) {
      state.partial++
      return
    }
    state.tip = result.tip
    state.ops += result.ops
    state.rejects += result.rejects
    if (!result.more) return
    if (result.ops === 0) {
      state.partial++
      getLogger().warn("ingestion-v2.step-partial", {
        step: label,
        workspaceId: ctx.destination.workspaceId,
        reason: `Page ${page} said more but the validator accepted no op`,
      })
      return
    }
  }
  state.partial++
  getLogger().warn("ingestion-v2.step-partial", {
    step: label,
    workspaceId: ctx.destination.workspaceId,
    reason: `The skill still had files after ${INGEST_MAX_PAGES} pages`,
  })
}

/**
 * One skill step for one Workspace. It returns `partial` after the third
 * failed attempt, or at once when the broker refuses the job: the root keeps
 * what the earlier steps wrote, and the run goes on (no retraction).
 */
async function runSkillStep(
  ctx: SkillPages & { name: string; oldTip: string | null; opsBefore: number },
): Promise<StepResult> {
  const { run, destination, ref, runBase, broker } = ctx
  let reason = ""
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    try {
      // A crash after the push: the step's commit is the ref tip, and its
      // `Ctxpipe-More` trailer says whether a next page waits.
      const found = await broker.find(ref, ctx.name)
      if (found)
        return { tip: found.sha, ops: found.ops, rejects: 0, more: found.more }
      const baseCommit = ctx.oldTip ?? runBase
      // A new shard ref starts at the run base, which is on the assembled ref.
      const fetchRef = ctx.oldTip
        ? ref
        : runBase !== destination.pinnedRevision
          ? ingestRefName({
              runId: run.runId,
              workspaceId: destination.workspaceId,
            })
          : undefined
      const rootMap = ingestRootMap(
        run.roots,
        baseCommit === destination.pinnedRevision
          ? []
          : await broker.listFiles(destination.pinnedRevision, baseCommit),
      )
      const { tar } = await ctx.runtime.runStep({
        name: ctx.name,
        skill: ctx.skill.name,
        run: ctx.skill.run,
        ...(ctx.skill.tier ? { tier: ctx.skill.tier } : {}),
        root: ctx.root,
        workspaceId: destination.workspaceId,
        baseCommit,
        ...(fetchRef ? { fetchRef } : {}),
        rootMap,
        signal: ingestStepSignal(),
      })
      const pushed = await withIngestStepOutput(tar, (stagedDir) =>
        broker.push({
          ref,
          oldTip: ctx.oldTip,
          pinnedRevision: runBase,
          baseCommit,
          commit: {
            step: ctx.name,
            bundle: run.bundle,
            authorTime: new Date(run.authorTime),
          },
          patch: {
            stagedDir,
            source: { url: run.source.url, sha: run.source.sha },
            skill: ctx.skill.name,
            sourcePathExists: (path) => broker.sourcePathExists(path),
            workspaceOpsBefore: ctx.opsBefore,
            // The host root of the package units of a root step (CTX-657).
            ...(ctx.root === null ? {} : { root: ctx.root }),
          },
        }),
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
        more: pushed.more,
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
