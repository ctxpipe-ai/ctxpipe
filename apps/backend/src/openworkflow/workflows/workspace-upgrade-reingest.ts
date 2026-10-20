import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import type { IngestionV2Input } from "../../domain/ingestion/ingestion-run.js"
import {
  classifyUpgradeFailure,
  isTemporaryFailure,
} from "../../domain/upgrades/failure.js"
import {
  type ReingestRepositoryReport,
  reingestedNames,
  UPGRADE_STATUSES,
  type UpgradeBlockedReason,
  upgradeJobId,
} from "../../domain/upgrades/registry.js"
import {
  ingestionRunSpend,
  ingestionRunState,
  isReingestUpgradeKey,
  REINGEST_REPOSITORY_WORKFLOW_NAME,
  REINGEST_THROTTLE,
  reingestBlock,
  reingestPollSeconds,
  reingestRunKey,
  reingestSlotTurn,
  reingestSource,
  workspaceSourceRepositories,
} from "../../domain/upgrades/reingest.js"
import {
  cancelIngestionRun,
  stopOrphanedReingestRuns,
} from "../../domain/upgrades/stop-orphans.js"
import { resolveRepositoryReadTip } from "../../domain/workspaces/resolve-revision.js"
import { CODE_FORMAT } from "../../domain/workspaces/workspace-format.js"
import { withWorkspaceWriteContext } from "../../domain/workspaces/write-command.js"
import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import {
  getWorkspaceById,
  legacyKnowledgePaths,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import {
  PlainGitUrlError,
  plainGitRefusalReason,
  resolvePlainGitTip,
} from "../../services/git/plain-git-remote.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { enqueueWorkspaceHydrate } from "../enqueue-workspace-hydrate.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { repositoryIngestionV2 } from "./repository-ingestion-v2.js"

export const workspaceUpgradeReingestInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    key: z.string().min(1),
  })
  .strict()

type Throttle = typeof REINGEST_THROTTLE

/**
 * OpenWorkflow 0.10 stops a run after 1000 step attempts
 * (`WORKFLOW_STEP_LIMIT` in `openworkflow/dist/worker/step-history.js`,
 * which the package does not export).
 */
const WORKFLOW_STEP_LIMIT = 1000

type Options = {
  /** A test gives short polls. */
  throttle?: Partial<Throttle>
  /** The step attempts that one run may use. OpenWorkflow stops a run above {@link WORKFLOW_STEP_LIMIT}; a test gives less. */
  stepBudget?: number
}

/**
 * The polls that fit in the step budget of one run. `fixed` is the count of
 * the other step attempts of the run; each poll is one check and one sleep.
 */
function pollBudget(stepBudget: number, fixed: number): number {
  return Math.max(0, Math.floor((stepBudget - fixed) / 2))
}

const sleepFor = (seconds: number) => `${seconds} seconds` as const

const repositoryInputSchema = z
  .object({
    orgId: z.string().min(1),
    workspaceId: z.string().min(1),
    upgradeRunId: z.string().min(1),
    repository: z.string().min(1),
    url: z.string().min(1),
    /** Null for a plain git repository (CTX-815). */
    githubConnectionId: z.string().min(1).nullable(),
    sha: z.string().min(1),
    authorTime: z.string().min(1),
  })
  .strict()

type RepositoryResult = Pick<
  ReingestRepositoryReport,
  "status" | "report" | "runId"
> & { spendUsd: number; spendUnknown: boolean }

const runOutputSchema = z
  .object({
    status: z.enum(["done", "partial", "skipped"]),
    reason: z.string().optional(),
    workspaces: z
      .array(
        z
          .object({
            workspaceId: z.string(),
            partial: z.number(),
            refused: z.string().optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough()

/**
 * The report of one finished ingestion v2 run for the Workspace of the
 * re-ingestion. It reads the result of this Workspace, not the status of
 * the run: a run that skipped the Workspace, or did not reach it, failed
 * for it.
 */
function runReport(
  state: Extract<Awaited<ReturnType<typeof ingestionRunState>>, { done: true }>,
  workspaceId: string,
): Pick<ReingestRepositoryReport, "status" | "report"> {
  if (state.status !== "completed")
    return {
      status: "failed",
      report: [
        state.status === "canceled"
          ? "The ingestion run was canceled."
          : `The ingestion run failed: ${state.error ?? "no reason given"}`,
      ],
    }
  const output = runOutputSchema.safeParse(state.output)
  if (!output.success)
    return {
      status: "failed",
      report: ["ctx| cannot read the result of the ingestion run."],
    }
  const reason = output.data.reason ? [output.data.reason] : []
  const result = output.data.workspaces?.find(
    (w) => w.workspaceId === workspaceId,
  )
  if (!result)
    return {
      status: "failed",
      report: [
        ...reason,
        "The ingestion run did not publish to this Workspace: the Workspace was not a destination of the run.",
      ],
    }
  if (result.refused !== undefined || result.partial > 0)
    return {
      status: "partial",
      report: result.refused !== undefined ? [result.refused] : reason,
    }
  return { status: "done", report: [] }
}

/**
 * One source repository of a re-ingestion: its own run, so that each
 * repository has its own step budget. It starts the ingestion v2 run at the
 * pinned commit, then reads its state and records its model spend with
 * polls that back off. Nothing caps the spend (ADR-052). The ingestion v2
 * publish is the normal path (ADR-047 broker,
 * `knowledge/` only).
 */
export function defineWorkspaceUpgradeReingestRepository(
  options: Options = {},
) {
  const throttle = { ...REINGEST_THROTTLE, ...options.throttle }
  const maxPolls = pollBudget(options.stepBudget ?? WORKFLOW_STEP_LIMIT, 2)
  return defineWorkflow(
    {
      name: REINGEST_REPOSITORY_WORKFLOW_NAME,
      schema: repositoryInputSchema,
    },
    async ({ input: queuedInput, step }): Promise<RepositoryResult> => {
      const input = repositoryInputSchema.parse(queuedInput)
      const runId = await step.run({ name: "start" }, async () => {
        const handle = await runWorkflowWithWorkerWake(
          repositoryIngestionV2.spec,
          {
            orgId: input.orgId,
            shadow: false,
            source: reingestSource(input),
            sha: input.sha,
            authorTime: input.authorTime,
            // Only this Workspace: the other Workspaces of the repository
            // did not approve a publish.
            destinations: [input.workspaceId],
          } satisfies IngestionV2Input,
          {
            idempotencyKey: reingestRunKey({
              orgId: input.orgId,
              workspaceId: input.workspaceId,
              upgradeRunId: input.upgradeRunId,
              repository: input.repository,
            }),
          },
        )
        return handle.workflowRun.id
      })
      for (let poll = 0; ; poll++) {
        const last = poll >= maxPolls
        const result = await step.run(
          { name: `check:${poll}` },
          async (): Promise<RepositoryResult | null> => {
            const state = await ingestionRunState(runId)
            const spend = await ingestionRunSpend(runId)
            const spendUsd = spend.usd
            const spendUnknown = spend.unknown
            if (state.done)
              return {
                ...runReport(state, input.workspaceId),
                runId,
                spendUsd,
                spendUnknown,
              }
            if (!last) return null
            await cancelIngestionRun(runId)
            return {
              status: "failed",
              runId,
              spendUsd,
              spendUnknown,
              report: [
                "The ingestion run did not finish in the time that the upgrade waits.",
              ],
            }
          },
        )
        if (result) return result
        await step.sleep(
          `wait:${poll}`,
          sleepFor(
            reingestPollSeconds(
              poll,
              throttle.firstPollSeconds,
              throttle.maxRunPollSeconds,
            ),
          ),
        )
      }
    },
  )
}

export const workspaceUpgradeReingestRepository =
  defineWorkspaceUpgradeReingestRepository()

const plannedSchema = z.union([
  z.object({ blocked: z.string(), note: z.string() }),
  z.object({
    repositories: z.array(
      z.object({
        repository: z.string(),
        url: z.string(),
        githubConnectionId: z.string().nullable(),
        sha: z.string().nullable(),
        /** Why ctx| could not read the tip (with no `sha`). */
        tipError: z.string().nullable().optional(),
        /** Done at this commit by an earlier run of this upgrade. */
        done: z
          .object({
            runId: z.string().nullable(),
            spendUsd: z.number(),
            spendUnknown: z.boolean(),
          })
          .nullable(),
      }),
    ),
  }),
])

/**
 * The reason of a failed tip read, for the report: the rule that refused a
 * plain git URL (with the protocol rule), or the last line that git wrote (at most 300 characters).
 * Git writes no credential there: a token goes in the environment, not in
 * the URL.
 */
function tipErrorText(error: unknown): string {
  if (error instanceof PlainGitUrlError) return plainGitRefusalReason(error)
  const stderr = String((error as { stderr?: unknown }).stderr ?? "")
  const line =
    stderr
      .split("\n")
      .map((part) => part.trim())
      .filter(Boolean)
      .at(-1) ??
    (error instanceof Error ? error.message.split("\n")[0] : String(error))
  return (line ?? "").slice(0, 300)
}

/**
 * Check the gates again at the run, and pin each source repository at its
 * default tip. A repository that an earlier run of the row did at the same
 * commit is done: a new start does not pay for it again.
 */
async function planReingest(input: {
  orgId: string
  workspaceId: string
  key: string
}): Promise<z.infer<typeof plannedSchema>> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) throw new Error("The Workspace is gone")
  const format = workspace.formatVersion
  if (format !== null && format > CODE_FORMAT)
    throw new Error(
      `The Workspace has format ${format}, which is newer than this ctx| version.`,
    )
  const blocked = reingestBlock({ ...workspace, format })
  if (blocked) return { blocked: blocked.blockedReason, note: blocked.note }
  const row = await getWorkspaceUpgradeRow(input.workspaceId, input.key)
  const earlier = new Map(
    (row?.upgrade.repositories ?? []).map((r) => [r.repository, r]),
  )
  const env = parseEnv(process.env)
  const repositories = []
  for (const source of await workspaceSourceRepositories(
    input.orgId,
    input.workspaceId,
  )) {
    // A repository that ctx| cannot read gets no run; the report names it
    // and the reason. A plain git repository is read with no credential,
    // from a host that passes the plain git rules (CTX-815).
    let tipError: string | null = null
    const tip = await (source.githubConnectionId
      ? resolveRepositoryReadTip({
          orgId: input.orgId,
          env,
          remote: { url: source.url, connectionId: source.githubConnectionId },
        })
      : resolvePlainGitTip(source.url)
    ).catch((error: unknown) => {
      tipError = tipErrorText(error)
      return null
    })
    const sha = tip?.sha ?? null
    if (!sha && !tipError) tipError = "The repository has no default branch."
    const before = earlier.get(source.repository)
    repositories.push({
      ...source,
      sha,
      tipError,
      done:
        sha && before?.status === "done" && before.sha === sha
          ? {
              runId: before.runId,
              spendUsd: before.spendUsd ?? 0,
              spendUnknown: before.spendUnknown === true,
            }
          : null,
    })
  }
  return { repositories }
}

/**
 * Build the re-ingestion workflow. A test gives short polls and a child
 * workflow with its own options.
 *
 * One run handles one re-ingestion row that an owner or admin started
 * (status `queued`, ADR-053 section 5). It claims the row, checks the gates
 * again, and pins each GitHub source repository at its default tip. Then it
 * waits for its throttle slot (`reingestSlotTurn`, ADR-052): one upgrade run
 * of an org at a time, held until the run ends, and a cap of runs on the
 * instance. It runs one child run for each repository, one after the other
 * (`workspace-upgrade-reingest-repository`), so that each repository has its
 * own step budget. It records the model spend of each run, and nothing
 * caps it (ADR-052). The row is `completed` when each repository is `done`
 * for this Workspace, else `failed` with the other repositories; the
 * operator can start it again. The next run skips each repository that is
 * done at the same commit.
 */
export function defineWorkspaceUpgradeReingest(
  options: Options & {
    repository?: ReturnType<typeof defineWorkspaceUpgradeReingestRepository>
  } = {},
) {
  const throttle = { ...REINGEST_THROTTLE, ...options.throttle }
  const stepBudget = options.stepBudget ?? WORKFLOW_STEP_LIMIT
  const repositoryWorkflow =
    options.repository ?? workspaceUpgradeReingestRepository
  const maxRepositories = Math.max(0, Math.floor((stepBudget - 5 - 2) / 2))
  return defineWorkflow(
    {
      name: "workspace-upgrade-reingest",
      schema: workspaceUpgradeReingestInputSchema,
    },
    async ({ input: queuedInput, step, run }) => {
      const input = workspaceUpgradeReingestInputSchema.parse(queuedInput)
      if (!isReingestUpgradeKey(input.key))
        throw new Error(`Unknown re-ingestion key ${input.key}`)
      const { orgId, workspaceId, key } = input
      return withWorkspaceWriteContext(
        { ...input, jobId: upgradeJobId(workspaceId, key) },
        "workspace-upgrade-reingest",
        async () => {
          const claimed = await step.run({ name: "claim" }, async () => {
            if (
              await transitionWorkspaceUpgradeRow({
                workspaceId,
                key,
                from: [UPGRADE_STATUSES.queued],
                to: UPGRADE_STATUSES.running,
                workflowRunId: run.id,
                failureReason: null,
              })
            )
              return { ok: true, status: UPGRADE_STATUSES.running }
            const row = await getWorkspaceUpgradeRow(workspaceId, key)
            return {
              ok:
                row?.status === UPGRADE_STATUSES.running &&
                row.workflowRunId === run.id,
              status: row?.status ?? null,
            }
          })
          if (!claimed.ok) return { started: false, status: claimed.status }
          type Fields = Omit<
            Parameters<typeof transitionWorkspaceUpgradeRow>[0],
            "workspaceId" | "key" | "from" | "ownerRunId"
          >
          const transition = async (name: string, fields: Fields) => {
            const before = fields.upgrade?.repositories
              ? reingestedNames(
                  (await getWorkspaceUpgradeRow(workspaceId, key))?.upgrade,
                )
              : []
            const moved = await transitionWorkspaceUpgradeRow({
              workspaceId,
              key,
              from: [UPGRADE_STATUSES.running],
              ownerRunId: run.id,
              ...fields,
            })
            // A repository that becomes done in this step replaces its
            // main-era knowledge. Hydrate projects the revision again, so
            // that the overlay of that repository goes (the publish
            // hydrate can come first).
            // Known limit: `before` comes from this step. If the step stops
            // after the transition and before the enqueue, the retry sees
            // no new done mark and queues no reproject. Then the main-era
            // knowledge of that repository stays in the projection until
            // the next hydrate of the Workspace (a push or a reproject).
            if (
              moved &&
              reingestedNames(moved.upgrade).some(
                (name) => !before.includes(name),
              ) &&
              (await legacyKnowledgePaths(workspaceId)).size
            )
              await enqueueWorkspaceHydrate(
                { orgId, workspaceId },
                getLogger(),
                {
                  idempotencyKey: (revision) =>
                    `legacy-overlay:${workspaceId}:${run.id}:${name}:${revision.sha}`,
                  reproject: true,
                },
              )
            return moved
          }
          const record = (name: string, fields: Fields) =>
            step.run({ name }, async () => {
              await transition(name, fields)
              return { started: true, status: fields.to }
            })
          /**
           * Record a failed run. A temporary cause (`isTemporaryFailure`)
           * gets one automatic retry with no agent (CTX-896): the row goes
           * back to `queued` with an `autoRetry` record, and one new run
           * starts. A row that has the record already failed once more, so it
           * becomes `failed` and the card shows.
           */
          const recordFailure = (name: string, fields: Fields) =>
            step.run({ name }, async () => {
              const current = await getWorkspaceUpgradeRow(workspaceId, key)
              const retry = current?.upgrade.autoRetry
              const enqueueRetry = async (approvedAt: string) => {
                await enqueueWorkspaceUpgradeReingest({
                  orgId,
                  workspaceId,
                  key,
                  approvedAt,
                })
                return { started: true, status: UPGRADE_STATUSES.queued }
              }
              // An earlier attempt of this step queued the row, and then
              // stopped before it queued the run. The key makes a second
              // queue of the same approval return the same run.
              if (
                current?.status === UPGRADE_STATUSES.queued &&
                retry?.failedRunId === run.id &&
                current.upgrade.approvedAt
              )
                return enqueueRetry(current.upgrade.approvedAt)
              const failure = retry
                ? null
                : classifyUpgradeFailure({
                    status: UPGRADE_STATUSES.failed,
                    failureReason: fields.failureReason ?? null,
                    repositories:
                      fields.upgrade?.repositories ??
                      current?.upgrade.repositories,
                  })
              if (failure && isTemporaryFailure(failure.code)) {
                const at = new Date().toISOString()
                const queued = await transition(name, {
                  ...fields,
                  to: UPGRADE_STATUSES.queued,
                  upgrade: {
                    ...fields.upgrade,
                    approvedAt: at,
                    autoRetry: { failedRunId: run.id, code: failure.code, at },
                  },
                  workflowRunId: null,
                  failureReason: null,
                })
                if (queued) return enqueueRetry(at)
              }
              await transition(name, fields)
              return { started: true, status: fields.to }
            })
          try {
            const planned = plannedSchema.parse(
              await step.run({ name: "plan" }, () =>
                planReingest({ orgId, workspaceId, key }),
              ),
            )
            if ("blocked" in planned)
              return record("record-blocked", {
                to: UPGRADE_STATUSES.blocked,
                upgrade: {
                  blockedReason: planned.blocked as UpgradeBlockedReason,
                  note: planned.note,
                },
              })
            // Refuse at the start, not halfway: the run has 5 fixed steps
            // and 2 for each repository, and it needs one slot poll (2 steps).
            if (planned.repositories.length > maxRepositories)
              throw new Error(
                `The Workspace has ${planned.repositories.length} source repositories. One re-ingestion run handles at most ${maxRepositories}. Remove some source repositories, then start it again.`,
              )
            const reports: ReingestRepositoryReport[] =
              planned.repositories.map((r) => ({
                repository: r.repository,
                sha: r.sha,
                runId: r.done?.runId ?? null,
                status: r.done ? "done" : r.sha ? "pending" : "failed",
                report: r.done
                  ? ["An earlier run did this commit."]
                  : r.sha
                    ? []
                    : [
                        `ctx| cannot read the default branch of the repository.${r.tipError ? ` ${r.tipError}` : ""}`,
                      ],
                ...(r.done
                  ? {
                      spendUsd: r.done.spendUsd,
                      ...(r.done.spendUnknown ? { spendUnknown: true } : {}),
                    }
                  : {}),
              }))
            await record("record-plan", {
              to: UPGRADE_STATUSES.running,
              upgrade: {
                repositories: reports,
                note: undefined,
              },
            })
            // The other steps: claim, plan, record-plan, one child and one
            // record for each repository, the last record, and record-error.
            const maxSlotPolls = pollBudget(
              stepBudget,
              7 + 2 * planned.repositories.length,
            )
            let waitedSince: string | null = null
            for (let poll = 0; ; poll++) {
              const slot = await step.run(
                { name: `slot:${poll}` },
                async () => {
                  await stopOrphanedReingestRuns()
                  return reingestSlotTurn({
                    orgId,
                    upgradeRunId: run.id,
                    runsPerInstance: throttle.runsPerInstance,
                    workspaceId,
                    sourceUrls: planned.repositories
                      .filter((r) => r.sha && !r.done)
                      .map((r) => r.url),
                  })
                },
              )
              if ("turn" in slot) {
                if (waitedSince)
                  await record("record-turn", {
                    to: UPGRADE_STATUSES.running,
                    upgrade: { waitingForSlot: undefined },
                  })
                break
              }
              if (!waitedSince) {
                waitedSince = await step.run(
                  { name: "record-wait" },
                  async () => {
                    const since = new Date().toISOString()
                    await transitionWorkspaceUpgradeRow({
                      workspaceId,
                      key,
                      from: [UPGRADE_STATUSES.running],
                      to: UPGRADE_STATUSES.running,
                      ownerRunId: run.id,
                      upgrade: {
                        waitingForSlot: { reason: slot.wait, since },
                      },
                    })
                    return since
                  },
                )
              }
              if (poll >= maxSlotPolls)
                return recordFailure("record-no-slot", {
                  to: UPGRADE_STATUSES.failed,
                  failureReason: `${slot.wait} The re-ingestion waited too long for its turn. Start it again.`,
                  upgrade: { repositories: reports, waitingForSlot: undefined },
                })
              await step.sleep(
                `wait-slot:${poll}`,
                sleepFor(
                  reingestPollSeconds(
                    poll,
                    throttle.firstPollSeconds,
                    throttle.maxSlotPollSeconds,
                  ),
                ),
              )
            }
            // A repository that an earlier run did keeps its spend in the
            // report.
            for (const [index, source] of planned.repositories.entries()) {
              const report = reports[index]
              if (!source.sha || !report || report.status === "done") continue
              const result: RepositoryResult = await step
                .runWorkflow(
                  repositoryWorkflow.spec,
                  {
                    orgId,
                    workspaceId,
                    upgradeRunId: run.id,
                    repository: source.repository,
                    url: source.url,
                    githubConnectionId: source.githubConnectionId,
                    sha: source.sha,
                    authorTime: run.createdAt.toISOString(),
                  },
                  { name: `repository:${index}` },
                )
                .catch((error: unknown) => {
                  if (isWorkflowControlSignal(error)) throw error
                  return {
                    status: "failed" as const,
                    runId: null,
                    spendUsd: 0,
                    spendUnknown: false,
                    report: [
                      `The repository run failed: ${error instanceof Error ? error.message : String(error)}`,
                    ],
                  }
                })
              Object.assign(report, {
                status: result.status,
                runId: result.runId,
                report: result.spendUnknown
                  ? [
                      ...result.report,
                      "Spend unknown: a model step reported no usage, so the spend counts only the known part.",
                    ]
                  : result.report,
                spendUsd: result.spendUsd,
                ...(result.spendUnknown ? { spendUnknown: true } : {}),
              })
              await record(`record-run:${index}`, {
                to: UPGRADE_STATUSES.running,
                upgrade: { repositories: reports },
              })
            }
            // Only a run that published all of its work to this Workspace
            // is done. A `partial` or `skipped` repository fails the row.
            const failed = reports.filter((r) => r.status !== "done")
            if (failed.length)
              return recordFailure("record-failed", {
                to: UPGRADE_STATUSES.failed,
                failureReason: `The re-ingestion did not finish for ${failed.map((r) => r.repository).join(", ")}. Start it again.`,
                upgrade: { repositories: reports },
              })
            return record("record-completed", {
              to: UPGRADE_STATUSES.completed,
              upgrade: { repositories: reports },
            })
          } catch (error) {
            if (isWorkflowControlSignal(error)) throw error
            return recordFailure("record-error", {
              to: UPGRADE_STATUSES.failed,
              failureReason:
                error instanceof Error ? error.message : String(error),
            })
          }
        },
      )
    },
  )
}

export const workspaceUpgradeReingest = defineWorkspaceUpgradeReingest()

/** Queue the run of a started re-ingestion row. A second queue of the same start returns the same run. */
export async function enqueueWorkspaceUpgradeReingest(input: {
  orgId: string
  workspaceId: string
  key: string
  approvedAt: string
}): Promise<void> {
  await runWorkflowWithWorkerWake(
    workspaceUpgradeReingest.spec,
    { orgId: input.orgId, workspaceId: input.workspaceId, key: input.key },
    {
      idempotencyKey: `${upgradeJobId(input.workspaceId, input.key)}:${input.approvedAt}`,
    },
  )
}
