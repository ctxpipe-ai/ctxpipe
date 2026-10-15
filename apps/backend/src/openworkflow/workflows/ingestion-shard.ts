import { setTimeout as delay } from "node:timers/promises"
import { type Span, SpanStatusCode } from "@opentelemetry/api"
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
  capIngestText,
  logIngestEvent,
  withIngestSpan,
} from "../../domain/ingestion/ingest-telemetry.js"
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
import { createLogger, withLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  cleanUpUnlessParked,
  isWorkflowControlSignal,
} from "../isSleepSignal.js"

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

/** The sum of one count over the Workspaces of a shard. */
function sum(
  workspaces: IngestionShardWorkspace[],
  key: "ops" | "rejects" | "partial",
): number {
  return workspaces.reduce((total, w) => total + w[key], 0)
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
      const runShardSpan = () =>
        withIngestSpan(
          "ingestion.shard",
          {
            "ctxpipe.org.id": input.orgId,
            "ctxpipe.ingest.run.id": input.runId,
            "ctxpipe.ingest.shard": String(input.shard),
            "ctxpipe.ingest.mode": input.mode,
            "ctxpipe.ingest.source.sha": input.source.sha,
            "ctxpipe.ingest.bundle": input.bundle,
          },
          async (span) => {
            const output = await runShard()
            span.setAttributes({
              "ctxpipe.ingest.workspaces": output.workspaces.length,
              "ctxpipe.ingest.ops": sum(output.workspaces, "ops"),
              "ctxpipe.ingest.rejects": sum(output.workspaces, "rejects"),
              "ctxpipe.ingest.partial": sum(output.workspaces, "partial"),
            })
            return output
          },
        )
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
          cleanUpUnlessParked(runShardSpan, async () => {
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
> & {
  /** The shard number, for telemetry; the parent's steps run in shard 0. */
  shard?: number
}

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
    rejects: number
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
  /** The text of `path` in the source at the run's SHA, or null. */
  readSourceFile(path: string): Promise<string | null>
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
    readSourceFile: (path) => source.read(path),
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
      logStepPartial(
        ctx,
        label,
        `Page ${page} said more but the validator accepted no op`,
      )
      return
    }
  }
  state.partial++
  logStepPartial(
    ctx,
    label,
    `The skill still had files after ${INGEST_MAX_PAGES} pages`,
  )
}

/** One log event for a step that ends `partial`, with its reason. */
function logStepPartial(
  ctx: Pick<SkillPages, "run" | "destination">,
  step: string,
  reason: string,
): void {
  logIngestEvent("warn", "ingestion-v2.step-partial", {
    ingestionRunId: ctx.run.runId,
    ...(ctx.run.shard === undefined ? {} : { shard: ctx.run.shard }),
    workspaceId: ctx.destination.workspaceId,
    ingestStep: step,
    reason: capIngestText(reason),
  })
}

/**
 * One skill step for one Workspace. It returns `partial` after the third
 * failed attempt, or at once when the broker refuses the job: the root keeps
 * what the earlier steps wrote, and the run goes on (no retraction).
 */
function runSkillStep(
  ctx: SkillPages & { name: string; oldTip: string | null; opsBefore: number },
): Promise<StepResult> {
  return withIngestSpan(
    "ingestion.step",
    {
      "ctxpipe.ingest.run.id": ctx.run.runId,
      ...(ctx.run.shard === undefined
        ? {}
        : { "ctxpipe.ingest.shard": String(ctx.run.shard) }),
      "ctxpipe.ingest.step": ctx.name,
      "ctxpipe.ingest.skill": ctx.skill.name,
      "ctxpipe.ingest.skill.run": ctx.skill.run,
      "ctxpipe.workspace.id": ctx.destination.workspaceId,
      "ctxpipe.ingest.ref.base": ctx.oldTip ?? ctx.runBase,
    },
    async (span) => {
      const result = await attemptSkillStep(ctx, span)
      if (result.partial) {
        span.setAttribute("ctxpipe.ingest.partial", true)
        span.setStatus({ code: SpanStatusCode.ERROR, message: "partial" })
      } else {
        span.setAttributes({
          "ctxpipe.ingest.ref.tip": result.tip,
          "ctxpipe.ingest.ops": result.ops,
          "ctxpipe.ingest.rejects": result.rejects,
          "ctxpipe.ingest.more": result.more,
        })
      }
      return result
    },
  )
}

async function attemptSkillStep(
  ctx: SkillPages & { name: string; oldTip: string | null; opsBefore: number },
  span: Span,
): Promise<StepResult> {
  const { run, destination, ref, runBase, broker } = ctx
  let reason = ""
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    span.setAttribute("ctxpipe.ingest.attempts", attempt)
    try {
      // A crash after the push: the step's commit is the ref tip, and its
      // `Ctxpipe-More` trailer says whether a next page waits.
      const found = await broker.find(ref, ctx.name)
      if (found)
        return {
          tip: found.sha,
          ops: found.ops,
          rejects: found.rejects,
          more: found.more,
        }
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
            readSourceFile: (path) => broker.readSourceFile(path),
            workspaceOpsBefore: ctx.opsBefore,
            // The host root of the package units of a root step (CTX-657).
            ...(ctx.root === null ? {} : { root: ctx.root }),
          },
        }),
      )
      // The step output keeps counts; each rejected op is its own log event.
      for (const rejection of pushed.validation.rejections)
        logIngestEvent("warn", "ingestion-v2.op-rejected", {
          ingestionRunId: run.runId,
          ...(run.shard === undefined ? {} : { shard: run.shard }),
          workspaceId: destination.workspaceId,
          ingestStep: ctx.name,
          rule: rejection.rule,
          path: capIngestText(rejection.path),
          reason: capIngestText(rejection.reason),
        })
      span.setAttribute("ctxpipe.ingest.validation", pushed.validation.status)
      if (pushed.validation.status === "partial")
        logIngestEvent("warn", "ingestion-v2.step-mostly-rejected", {
          ingestionRunId: run.runId,
          ...(run.shard === undefined ? {} : { shard: run.shard }),
          workspaceId: destination.workspaceId,
          ingestStep: ctx.name,
          reason: `The validator rejected ${pushed.validation.rejections.length} ops and accepted ${pushed.validation.accepted.length}`,
        })
      return {
        tip: pushed.sha,
        ops: pushed.validation.accepted.length,
        rejects: pushed.validation.rejections.length,
        more: pushed.more,
      }
    } catch (error) {
      if (isWorkflowControlSignal(error)) throw error
      const refused = error instanceof IngestRefRefusedError
      reason = refused ? "broker_refused" : "step_failed"
      span.setAttribute(
        "error.type",
        refused ? "IngestRefRefusedError" : "Error",
      )
      if (refused) break
      if (attempt < STEP_ATTEMPTS) await delay(attempt * 5_000)
    }
  }
  logStepPartial(ctx, ctx.name, reason)
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
