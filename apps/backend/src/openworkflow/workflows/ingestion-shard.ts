import { setTimeout as delay } from "node:timers/promises"

import { type Span, SpanStatusCode } from "@opentelemetry/api"
import { z } from "zod"

import { type Env, parseEnv } from "../../config/env.js"
import {
  IngestRefMovedError,
  IngestRefRefusedError,
  ingestRefName,
  type PushIngestStepInput,
} from "../../domain/ingestion/ingest-refs.js"
import {
  IngestStepCommandError,
  ingestStepSignal,
} from "../../domain/ingestion/ingest-shard-ops.js"
import type {
  IngestDestination,
  IngestShardRuntime,
  IngestShardRuntimeFactory,
  IngestStepUsage,
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
  ingestErrorFields,
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
import {
  INGESTION_SHARD_WORKFLOW_NAME,
  ingestSourceWith,
} from "../../domain/ingestion/ingestion-run.js"
import { withIngestionOrg } from "../../domain/ingestion/ingestion-v2-resolve.js"
import type { PatchStepResult } from "../../domain/ingestion/patch-validator.js"
import {
  type IngestSkillBundle,
  readIngestSkillBundle,
} from "../../domain/ingestion/skill-bundle.js"
import { checkSourcePath } from "../../domain/workspace-sources/source-file.js"
import { workspaceRootPathSchema } from "../../domain/workspaces/root-path.js"
import {
  findWorkspaceStepCommit,
  listWorkspaceIngestStepFiles,
  pushWorkspaceIngestStep,
} from "../../domain/workspaces/write-broker.js"
import { WORKER_BOOT_ID, withCrashLoopGuard } from "../crash-loop.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import {
  openWorkflowExecution,
  type WorkflowExecution,
  WorkflowLeaseLostError,
} from "../execution-lease.js"
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
  rootPath: workspaceRootPathSchema.optional(),
  /** The source file of the run's repository in this Workspace (ADR-050). */
  sourcePath: z
    .string()
    .refine((path) => checkSourcePath(path).ok, "Use a source file path"),
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
  /** A GitHub or a plain git source (CTX-815), at the run's SHA. */
  source: ingestSourceWith({ sha, repositoryId: z.string().nullable() }),
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
  /**
   * The roots of the steps that failed. Their deletes are not published (no
   * retraction, concept section 7.3). A repository-wide step has no root.
   */
  partialRoots: string[]
  /**
   * The steps that failed after their 3 attempts, by the cause of the last
   * attempt (CTX-896). A page limit, a page with no op, and a broker refusal
   * are `partial` but not here: a second run gets the same result.
   */
  stepFailures?: IngestStepFailures
}

/**
 * The cause of the last failed attempt of a step: its time limit, a model
 * error, or another cause. `crashLoop`: the step stopped the worker again and
 * again (for example, out of memory), so the step did not run again.
 */
type IngestStepFailureKind = "timeLimit" | "model" | "other" | "crashLoop"
export type IngestStepFailures = Partial<Record<IngestStepFailureKind, number>>

/** The sum of step failure counts; undefined when no step failed. */
export function addStepFailures(
  ...counts: ReadonlyArray<IngestStepFailures | undefined>
): IngestStepFailures | undefined {
  const total: IngestStepFailures = {}
  for (const count of counts)
    for (const [kind, n] of Object.entries(count ?? {}) as Array<
      [IngestStepFailureKind, number]
    >)
      total[kind] = (total[kind] ?? 0) + n
  return Object.keys(total).length ? total : undefined
}

export type IngestionShardOutput = {
  shard: number
  workspaces: IngestionShardWorkspace[]
}

/** At most 2 retries for each step (concept section 8). */
const STEP_ATTEMPTS = 3
/** A skill runs at most this many pages; then it is `partial` (ADR-052 section 6). */
export const INGEST_MAX_PAGES = 20

type StepResult = (
  | {
      tip: string
      ops: number
      rejects: number
      more: boolean
      partial?: undefined
    }
  | { partial: true; failed?: IngestStepFailureKind }
) & {
  /** The model usage of the step's attempts, when the runtime reports it (the recorded spend reads it). */
  usage?: IngestStepUsage
}

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
      logFields: (input) => ({
        orgId: input.orgId,
        ingestionRunId: input.runId,
        shard: input.shard,
      }),
      name: INGESTION_SHARD_WORKFLOW_NAME,
      schema: ingestionShardInputSchema,
    },
    async ({ input, step, run }) => {
      const execution = openWorkflowExecution(step, run.id)
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
          () =>
            withCrashLoopGuard(run.id, "ensure-sandbox", async () => {
              await runtime.ensure()
              return { ready: true }
            }),
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
                partialRoots: [],
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
                step: guardedSkillStep(step, run.id, input.orgId),
                execution,
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
      // The child's own copy of the source tree and its index
      // repositories go when the child ends, also when it fails. A sibling
      // child has its own copies. A stale execution keeps them while another
      // execution has the run (CTX-1080).
      return cleanUpUnlessParked(
        runShardSpan,
        async () => {
          await releaseIngestSourceTree(
            input.runId,
            input.source.sha,
            shardTreeHolder(input),
          )
          await releaseIngestStepIndexes(input.runId, input.shard)
        },
        execution,
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
  /**
   * The step's commit on the ref after `since` (a crash after the push, or
   * another execution of the same child), else the tip that another
   * execution moved the ref to, else null.
   */
  find(
    ref: string,
    step: string,
    since: string,
  ): Promise<
    | { sha: string; ops: number; rejects: number; more: boolean }
    | { tip: string; ops: number }
    | null
  >
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
    find: (ref, step, since) =>
      findWorkspaceStepCommit(
        { orgId: input.orgId, job, ref, step, since },
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

/**
 * The `step` of `runSkillPages`: one `step.run` with no OpenWorkflow retry,
 * in the org of the run. A step that stopped the worker again and again
 * (CTX-971) ends `partial` with the `crashLoop` cause and does not run
 * again; the run goes on with the next step.
 */
export function guardedSkillStep(
  step: {
    run: <O>(
      config: { name: string; retryPolicy: { maximumAttempts: number } },
      fn: () => Promise<O>,
    ) => Promise<O>
  },
  workflowRunId: string,
  orgId: string,
): SkillPages["step"] {
  return (name, fn) =>
    step.run({ name, retryPolicy: { maximumAttempts: 1 } }, () =>
      withCrashLoopGuard(
        workflowRunId,
        name,
        () => withIngestionOrg(orgId, fn),
        (): StepResult => ({ partial: true, failed: "crashLoop" }),
      ),
    )
}

type SkillPages = {
  /** One workflow step: `step.run` with no OpenWorkflow retry. */
  step: (name: string, fn: () => Promise<StepResult>) => Promise<StepResult>
  /**
   * The OpenWorkflow execution that runs the steps. Each attempt first
   * makes sure that the execution still owns the run (CTX-1080).
   */
  execution?: WorkflowExecution
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
  const seen: SkillStep["seen"] = {}
  const failed = () => {
    state.partial++
    if (ctx.root !== null && !state.partialRoots.includes(ctx.root))
      state.partialRoots.push(ctx.root)
  }
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
      runSkillStep({ ...ctx, name, oldTip, opsBefore, seen }),
    )
    if (result.partial) {
      failed()
      if (result.failed)
        state.stepFailures = addStepFailures(state.stepFailures, {
          [result.failed]: 1,
        })
      return
    }
    state.tip = result.tip
    state.ops += result.ops
    state.rejects += result.rejects
    if (!result.more) return
    if (result.ops === 0) {
      failed()
      logStepPartial(
        ctx,
        label,
        `Page ${page} said more but the validator accepted no op`,
        seen.executionAttempt,
      )
      return
    }
  }
  failed()
  logStepPartial(
    ctx,
    label,
    `The skill still had files after ${INGEST_MAX_PAGES} pages`,
    seen.executionAttempt,
  )
}

/** One page of a skill, with the page fields of `runSkillPages`. */
type SkillStep = SkillPages & {
  name: string
  oldTip: string | null
  opsBefore: number
  /**
   * The execution attempt from the last ownership check of a step of this
   * execution, for the page events (CTX-1080). A cached step does not check.
   */
  seen: { executionAttempt?: number }
}

/**
 * The execution that writes a step event (CTX-1080): the worker process and,
 * when the step checked the lease, the execution attempt of the run.
 */
function executionFields(executionAttempt: number | undefined) {
  return {
    workerBootId: WORKER_BOOT_ID,
    ...(executionAttempt === undefined ? {} : { executionAttempt }),
  }
}

/** One log event for a step that ends `partial`, with its reason. */
function logStepPartial(
  ctx: Pick<SkillPages, "run" | "destination">,
  step: string,
  reason: string,
  executionAttempt?: number,
): void {
  logIngestEvent("warn", "ingestion-v2.step-partial", {
    ingestionRunId: ctx.run.runId,
    ...(ctx.run.shard === undefined ? {} : { shard: ctx.run.shard }),
    workspaceId: ctx.destination.workspaceId,
    ingestStep: step,
    reason: capIngestText(reason),
    ...executionFields(executionAttempt),
  })
}

/**
 * One skill step for one Workspace. It returns `partial` after the third
 * failed attempt, or at once when the broker refuses the job: the root keeps
 * what the earlier steps wrote, and the run goes on (no retraction).
 */
function runSkillStep(ctx: SkillStep): Promise<StepResult> {
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
  ctx: SkillStep,
  span: Span,
): Promise<StepResult> {
  const { run, destination, ref, runBase, broker } = ctx
  // The ref tip that the step starts from. Another execution of the same
  // child can move the ref (CTX-1073): `find` then gives its commit of this
  // step, or its tip, from which the step continues.
  let oldTip = ctx.oldTip
  // The ops of the other execution's commits that the step continues from.
  // The step result counts them, so the run cap of later steps holds them.
  let adopted = 0
  let reason = ""
  let failed: IngestStepFailureKind = "other"
  // The error type of the last failed attempt. The span gets it only when
  // the step ends `partial`: a later attempt can adopt or succeed.
  let errorType = ""
  let usage: IngestStepUsage | undefined
  const withUsage = <T extends object>(result: T) =>
    usage ? { ...result, usage } : result
  // The execution attempt from the last ownership check.
  let executionAttempt: number | undefined
  for (let attempt = 1; attempt <= STEP_ATTEMPTS; attempt++) {
    // After a lease loss, another execution runs the same steps. This one
    // stops before it makes model calls of its own.
    if (ctx.execution) {
      const lease = {
        ingestionRunId: run.runId,
        ...(run.shard === undefined ? {} : { shard: run.shard }),
        workspaceId: destination.workspaceId,
        ingestStep: ctx.name,
        attempt,
        workflowRunId: ctx.execution.workflowRunId,
        ...executionFields(executionAttempt),
      }
      // A failed read of the run is not a lease loss. The execution goes on
      // as the owner, so that a database error does not stop a live
      // execution.
      const owned = await ctx.execution.ownsRun().catch((error: unknown) => {
        logIngestEvent("warn", "ingestion-v2.execution-lease-check-failed", {
          ...lease,
          ...ingestErrorFields(error),
        })
        return "unknown" as const
      })
      if (owned === undefined) {
        logIngestEvent("warn", "ingestion-v2.execution-lease-lost", lease)
        throw new WorkflowLeaseLostError(ctx.execution.workflowRunId)
      }
      if (owned !== "unknown") {
        executionAttempt = owned
        ctx.seen.executionAttempt = owned
      }
    }
    const execution = executionFields(executionAttempt)
    span.setAttribute("ctxpipe.ingest.attempts", attempt)
    if (executionAttempt !== undefined)
      span.setAttribute("openworkflow.execution.attempt", executionAttempt)
    // The span of a step that stops the worker is never exported; this
    // event names the step that was in progress (CTX-971).
    logIngestEvent("info", "ingestion-v2.step-attempt-started", {
      ingestionRunId: run.runId,
      ...(run.shard === undefined ? {} : { shard: run.shard }),
      workspaceId: destination.workspaceId,
      ingestStep: ctx.name,
      attempt,
      ...execution,
    })
    // Where the attempt is, for the log of a failed attempt.
    let stage: "find" | "list-files" | "runtime" | "push" = "find"
    const signal = ingestStepSignal()
    try {
      // A crash after the push: the step's commit is on the ref, and its
      // `Ctxpipe-More` trailer says whether a next page waits.
      const found = await broker.find(ref, ctx.name, oldTip ?? runBase)
      // The span names the adoption (CTX-1080): `commit` when the step takes
      // a commit of this step that is on the ref, `tip` when it continues
      // from a tip that another execution moved the ref to.
      if (found && "sha" in found) {
        span.setAttributes({
          "ctxpipe.ingest.adopted": "commit",
          "ctxpipe.ingest.adopted.ops": adopted + found.ops,
        })
        return withUsage({
          tip: found.sha,
          ops: adopted + found.ops,
          rejects: found.rejects,
          more: found.more,
        })
      }
      if (found) {
        oldTip = found.tip
        adopted += found.ops
        span.setAttributes({
          "ctxpipe.ingest.adopted": "tip",
          "ctxpipe.ingest.adopted.ops": adopted,
        })
      }
      const baseCommit = oldTip ?? runBase
      // A new shard ref starts at the run base, which is on the assembled ref.
      const fetchRef = oldTip
        ? ref
        : runBase !== destination.pinnedRevision
          ? ingestRefName({
              runId: run.runId,
              workspaceId: destination.workspaceId,
            })
          : undefined
      stage = "list-files"
      const rootMap = ingestRootMap(
        run.roots,
        baseCommit === destination.pinnedRevision
          ? []
          : await broker.listFiles(destination.pinnedRevision, baseCommit),
      )
      stage = "runtime"
      const stepRun = await ctx.runtime.runStep({
        name: ctx.name,
        skill: ctx.skill.name,
        run: ctx.skill.run,
        ...(ctx.skill.tier ? { tier: ctx.skill.tier } : {}),
        root: ctx.root,
        workspaceId: destination.workspaceId,
        baseCommit,
        ...(fetchRef ? { fetchRef } : {}),
        rootMap,
        signal,
      })
      // A runtime that cannot report the usage of a model step makes the
      // spend unknown. The step counts as unknown, so that the spend does not
      // look complete.
      const stepUsage =
        stepRun.usage ??
        (ctx.skill.run === "model"
          ? { inputTokens: 0, outputTokens: 0, unknownSteps: 1 }
          : undefined)
      if (stepUsage?.unknownSteps)
        logIngestEvent("warn", "ingestion-v2.usage-unknown", {
          ingestionRunId: run.runId,
          ...(run.shard === undefined ? {} : { shard: run.shard }),
          workspaceId: destination.workspaceId,
          ingestStep: ctx.name,
          reason:
            "The model step reported no usage, or the worker kept only a part of it: the spend of the run is unknown, and the recorded spend counts only the known part",
          ...execution,
        })
      usage = addIngestUsage(usage, stepUsage)
      stage = "push"
      const pushed = await withIngestStepOutput(stepRun.tar, (stagedDir) =>
        broker.push({
          ref,
          oldTip,
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
            sourcePath: destination.sourcePath,
            skill: ctx.skill.name,
            sourcePathExists: (path) => broker.sourcePathExists(path),
            readSourceFile: (path) => broker.readSourceFile(path),
            workspaceOpsBefore: ctx.opsBefore + adopted,
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
          ...execution,
        })
      span.setAttribute("ctxpipe.ingest.validation", pushed.validation.status)
      if (pushed.validation.status === "partial")
        logIngestEvent("warn", "ingestion-v2.step-mostly-rejected", {
          ingestionRunId: run.runId,
          ...(run.shard === undefined ? {} : { shard: run.shard }),
          workspaceId: destination.workspaceId,
          ingestStep: ctx.name,
          reason: `The validator rejected ${pushed.validation.rejections.length} ops and accepted ${pushed.validation.accepted.length}`,
          ...execution,
        })
      return withUsage({
        tip: pushed.sha,
        ops: adopted + pushed.validation.accepted.length,
        rejects: pushed.validation.rejections.length,
        more: pushed.more,
      })
    } catch (error) {
      if (isWorkflowControlSignal(error)) throw error
      const refused = error instanceof IngestRefRefusedError
      reason = refused ? "broker_refused" : "step_failed"
      // The error text can hold source text, so the log has only where the
      // attempt failed (the stage, the step command and its exit code, or
      // the time limit) and the fields of `ingestErrorFields`.
      const command = error instanceof IngestStepCommandError ? error : null
      failed = signal.aborted
        ? "timeLimit"
        : command?.model?.errors.length
          ? "model"
          : "other"
      logIngestEvent("warn", "ingestion-v2.step-attempt-failed", {
        ingestionRunId: run.runId,
        ...(run.shard === undefined ? {} : { shard: run.shard }),
        workspaceId: destination.workspaceId,
        ingestStep: ctx.name,
        attempt,
        stage: signal.aborted ? "time-limit" : (command?.part ?? stage),
        ...(command ? { exitCode: command.exitCode } : {}),
        ...(command?.model
          ? {
              modelCalls: command.model.calls,
              modelErrors: command.model.errors,
            }
          : {}),
        ...ingestErrorFields(error),
        ...execution,
      })
      errorType = refused ? error.name : "Error"
      // The next attempt's `find` reads the ref that another execution moved.
      if (error instanceof IngestRefMovedError) continue
      if (refused) break
      if (attempt < STEP_ATTEMPTS) await delay(attempt * 5_000)
    }
  }
  if (errorType) span.setAttribute("error.type", errorType)
  logStepPartial(ctx, ctx.name, reason, executionAttempt)
  return withUsage({
    partial: true as const,
    ...(reason === "step_failed" ? { failed } : {}),
  })
}

function addIngestUsage(
  total: IngestStepUsage | undefined,
  next: IngestStepUsage | undefined,
): IngestStepUsage | undefined {
  if (!next) return total
  if (!total) return next
  // A part with no tokens (an unknown step) does not drop the known cost.
  const cost = (u: IngestStepUsage) =>
    u.costUsd ?? (u.inputTokens + u.outputTokens === 0 ? 0 : undefined)
  const [a, b] = [cost(total), cost(next)]
  const costUsd = a !== undefined && b !== undefined ? a + b : undefined
  const unknownSteps = (total.unknownSteps ?? 0) + (next.unknownSteps ?? 0)
  const cacheReadTokens =
    (total.cacheReadTokens ?? 0) + (next.cacheReadTokens ?? 0)
  return {
    inputTokens: total.inputTokens + next.inputTokens,
    outputTokens: total.outputTokens + next.outputTokens,
    ...(cacheReadTokens ? { cacheReadTokens } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
    ...(unknownSteps ? { unknownSteps } : {}),
  }
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
