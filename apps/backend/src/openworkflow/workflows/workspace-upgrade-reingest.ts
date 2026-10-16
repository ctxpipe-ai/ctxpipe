import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import type { IngestionV2Input } from "../../domain/ingestion/ingestion-run.js"
import {
  type ReingestRepositoryReport,
  UPGRADE_STATUSES,
  type UpgradeBlockedReason,
  upgradeJobId,
} from "../../domain/upgrades/registry.js"
import {
  activeIngestionRunTree,
  ingestionRunSpend,
  ingestionRunState,
  isReingestUpgradeKey,
  REINGEST_THROTTLE,
  reingestBlock,
  reingestPollSeconds,
  reingestRunKey,
  reingestSlotTurn,
  workspaceSourceRepositories,
} from "../../domain/upgrades/reingest.js"
import { resolveRepositoryReadTip } from "../../domain/workspaces/resolve-revision.js"
import { CODE_FORMAT } from "../../domain/workspaces/workspace-format.js"
import { withWorkspaceWriteContext } from "../../domain/workspaces/write-command.js"
import {
  getWorkspaceUpgradeRow,
  transitionWorkspaceUpgradeRow,
} from "../../models/workspace-upgrades.js"
import { getWorkspaceById } from "../../models/workspaces.js"
import { ow, runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
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
    githubConnectionId: z.string().min(1),
    sha: z.string().min(1),
    authorTime: z.string().min(1),
    /** Stop the ingestion run when its spend passes this (USD). Null: no cap. */
    capUsd: z.number().nullable(),
  })
  .strict()

type RepositoryResult = Pick<
  ReingestRepositoryReport,
  "status" | "report" | "runId"
> & { spendUsd: number; spendUnknown: boolean; capped: boolean }

const runOutputSchema = z
  .object({
    status: z.enum(["done", "partial", "skipped"]),
    reason: z.string().optional(),
  })
  .passthrough()

/** The report of one finished ingestion v2 run. */
function runReport(
  state: Extract<Awaited<ReturnType<typeof ingestionRunState>>, { done: true }>,
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
  if (!output.success) return { status: "done", report: [] }
  return {
    status: output.data.status,
    report: output.data.reason ? [output.data.reason] : [],
  }
}

/** Cancel an ingestion v2 run and its child runs, so that they spend no more. */
async function cancelIngestionRun(runId: string): Promise<void> {
  for (const id of await activeIngestionRunTree(runId))
    await ow.cancelWorkflowRun(id).catch(() => undefined)
}

const usd = (value: number) => `$${value.toFixed(2)}`

/**
 * One source repository of a re-ingestion: its own run, so that each
 * repository has its own step budget. It starts the ingestion v2 run at the
 * pinned commit, then reads its state and its model spend with polls that
 * back off. When the spend passes `capUsd`, it cancels the ingestion run.
 * The ingestion v2 publish is the normal path (ADR-047 broker, `knowledge/`
 * only).
 */
export function defineWorkspaceUpgradeReingestRepository(
  options: Options = {},
) {
  const throttle = { ...REINGEST_THROTTLE, ...options.throttle }
  const maxPolls = pollBudget(options.stepBudget ?? WORKFLOW_STEP_LIMIT, 2)
  return defineWorkflow(
    {
      name: "workspace-upgrade-reingest-repository",
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
            source: {
              url: input.url,
              githubConnectionId: input.githubConnectionId,
            },
            sha: input.sha,
            authorTime: input.authorTime,
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
                ...runReport(state),
                runId,
                spendUsd,
                spendUnknown,
                capped: false,
              }
            const capped = input.capUsd !== null && spendUsd > input.capUsd
            if (!capped && !last) return null
            await cancelIngestionRun(runId)
            return {
              status: "failed",
              runId,
              spendUsd,
              spendUnknown,
              capped,
              report: [
                capped
                  ? `ctx| stopped the ingestion run at the cost cap: it spent ${usd(spendUsd)}, and the cap left for it was ${usd(input.capUsd ?? 0)}.`
                  : "The ingestion run did not finish in the time that the upgrade waits.",
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
    capUsd: z.number().nullable(),
    repositories: z.array(
      z.object({
        repository: z.string(),
        url: z.string(),
        githubConnectionId: z.string(),
        sha: z.string().nullable(),
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
  const high = row?.upgrade.estimate?.costUsd.high
  const env = parseEnv(process.env)
  const repositories = []
  for (const source of await workspaceSourceRepositories(
    input.orgId,
    input.workspaceId,
  )) {
    // A repository that ctx| cannot read gets no run; the report names it.
    const tip = await resolveRepositoryReadTip({
      orgId: input.orgId,
      env,
      remote: { url: source.url, connectionId: source.githubConnectionId },
    }).catch(() => null)
    const sha = tip?.sha ?? null
    const before = earlier.get(source.repository)
    repositories.push({
      ...source,
      sha,
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
  // The cost cap: 2 times the p90 estimate of the whole re-ingestion.
  return { capUsd: high === undefined ? null : 2 * high, repositories }
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
 * own step budget. The model spend of the runs adds up; when it passes 2
 * times the p90 estimate, the run stops with `failed` and the spend. The row
 * is `completed` when no repository failed, else `failed` with the
 * repositories that failed; the operator can start it again, and the next run
 * skips each repository that is done at the same commit.
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
          const record = (
            name: string,
            fields: Omit<
              Parameters<typeof transitionWorkspaceUpgradeRow>[0],
              "workspaceId" | "key" | "from" | "ownerRunId"
            >,
          ) =>
            step.run({ name }, async () => {
              await transitionWorkspaceUpgradeRow({
                workspaceId,
                key,
                from: [UPGRADE_STATUSES.running],
                ownerRunId: run.id,
                ...fields,
              })
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
                        "ctx| cannot read the default branch of the repository.",
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
                stopReason: undefined,
              },
            })
            // The other steps: claim, plan, record-plan, one child and one
            // record for each repository, the last record, and record-error.
            const maxSlotPolls = pollBudget(
              stepBudget,
              5 + 2 * planned.repositories.length,
            )
            for (let poll = 0; ; poll++) {
              const slot = await step.run({ name: `slot:${poll}` }, () =>
                reingestSlotTurn({
                  orgId,
                  upgradeRunId: run.id,
                  runsPerInstance: throttle.runsPerInstance,
                }),
              )
              if ("turn" in slot) break
              if (poll >= maxSlotPolls)
                return record("record-no-slot", {
                  to: UPGRADE_STATUSES.failed,
                  failureReason: `${slot.wait} The re-ingestion waited too long for its turn. Start it again.`,
                  upgrade: { repositories: reports },
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
            let spent = reports.reduce((sum, r) => sum + (r.spendUsd ?? 0), 0)
            let capped = false
            for (const [index, source] of planned.repositories.entries()) {
              const report = reports[index]
              if (!source.sha || !report || report.status === "done") continue
              if (capped) {
                Object.assign(report, {
                  status: "failed",
                  report: [
                    "Not started: the re-ingestion stopped at the cost cap.",
                  ],
                })
                continue
              }
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
                    capUsd:
                      planned.capUsd === null
                        ? null
                        : Math.max(0, planned.capUsd - spent),
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
                    capped: false,
                    report: [
                      `The repository run failed: ${error instanceof Error ? error.message : String(error)}`,
                    ],
                  }
                })
              spent += result.spendUsd
              capped =
                result.capped ||
                (planned.capUsd !== null && spent > planned.capUsd)
              Object.assign(report, {
                status: result.status,
                runId: result.runId,
                report: result.spendUnknown
                  ? [
                      ...result.report,
                      "Spend unknown: a model step reported no usage, so the spend and the cost cap count only the known part.",
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
            if (capped)
              return record("record-cost-cap", {
                to: UPGRADE_STATUSES.failed,
                failureReason: `The re-ingestion stopped at the cost cap (cost_cap): the model spend is ${usd(spent)}, and the cap is ${usd(planned.capUsd ?? 0)} (2 times the p90 estimate).`,
                upgrade: { repositories: reports, stopReason: "cost_cap" },
              })
            const failed = reports.filter((r) => r.status === "failed")
            if (failed.length)
              return record("record-failed", {
                to: UPGRADE_STATUSES.failed,
                failureReason: `The re-ingestion failed for ${failed.map((r) => r.repository).join(", ")}. Start it again.`,
                upgrade: { repositories: reports },
              })
            return record("record-completed", {
              to: UPGRADE_STATUSES.completed,
              upgrade: { repositories: reports },
            })
          } catch (error) {
            if (isWorkflowControlSignal(error)) throw error
            return record("record-error", {
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
