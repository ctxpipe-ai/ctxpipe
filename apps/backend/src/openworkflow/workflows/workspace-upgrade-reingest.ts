import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import type { IngestionV2Input } from "../../domain/ingestion/ingestion-run.js"
import {
  type IngestionPublishPipeline,
  ingestionPublishPipeline,
} from "../../domain/ingestion/ingestion-v2-config.js"
import {
  type ReingestRepositoryReport,
  UPGRADE_BLOCKED_REASONS,
  UPGRADE_STATUSES,
  type UpgradeBlockedReason,
  upgradeJobId,
} from "../../domain/upgrades/registry.js"
import {
  ingestionRunState,
  ingestSandboxUnavailable,
  isReingestUpgradeKey,
  REINGEST_REQUIRES_FORMAT,
  REINGEST_THROTTLE,
  reingestRunKey,
  takeReingestSlot,
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
import { runWorkflowWithWorkerWake } from "../client.js"
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

type Blocked = { blocked: UpgradeBlockedReason; note: string }

const plannedSchema = z.union([
  z.object({ blocked: z.string(), note: z.string() }),
  z.object({
    repositories: z.array(
      z.object({
        repository: z.string(),
        url: z.string(),
        githubConnectionId: z.string(),
        sha: z.string().nullable(),
      }),
    ),
  }),
])

/** Check the gates again at the run, and pin each source repository at its default tip. */
async function planReingest(input: {
  orgId: string
  workspaceId: string
  publishPipeline: IngestionPublishPipeline
}): Promise<z.infer<typeof plannedSchema>> {
  const workspace = await getWorkspaceById(input.workspaceId)
  if (!workspace) throw new Error("The Workspace is gone")
  const format = workspace.formatVersion
  const sandbox = ingestSandboxUnavailable()
  const blocked: Blocked | null =
    format === null || format < REINGEST_REQUIRES_FORMAT || format > CODE_FORMAT
      ? {
          blocked: UPGRADE_BLOCKED_REASONS.needsFormat,
          note: `Re-ingestion needs format ${REINGEST_REQUIRES_FORMAT}. Merge the format upgrade first.`,
        }
      : input.publishPipeline !== "v2"
        ? {
            blocked: UPGRADE_BLOCKED_REASONS.ingestionV2Off,
            note: "This ctx| version does not publish with ingestion v2, so a re-ingestion cannot publish.",
          }
        : sandbox
          ? {
              blocked: UPGRADE_BLOCKED_REASONS.sandboxUnavailable,
              note: sandbox,
            }
          : workspace.writeStatus === "read_only"
            ? {
                blocked: UPGRADE_BLOCKED_REASONS.writeAccess,
                note:
                  workspace.readOnlyReason ??
                  "ctx| cannot write to this repository.",
              }
            : null
  if (blocked) return blocked
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
    repositories.push({ ...source, sha: tip?.sha ?? null })
  }
  return { repositories }
}

const runOutputSchema = z
  .object({
    status: z.enum(["done", "partial", "skipped"]),
    reason: z.string().optional(),
  })
  .passthrough()

/** The report of one finished ingestion v2 run. */
function runReport(
  state: Awaited<ReturnType<typeof ingestionRunState>>,
): Pick<ReingestRepositoryReport, "status" | "report"> {
  if (!state.done) return { status: "pending", report: [] }
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

/**
 * Build the re-ingestion workflow. Production reads the committed publish
 * pipeline; a test gives `v2`. The ingestion v2 runs go to the workflow name
 * `repository-ingestion-v2`, so a test worker can implement it with a
 * stand-in sandbox.
 *
 * One run handles one re-ingestion row that an owner or admin started
 * (status `queued`, ADR-053 section 5). It claims the row, checks the gates
 * again, and pins each GitHub source repository at its default tip. Then it
 * runs ingestion v2 for each repository, one after the other. Each run
 * waits for a throttle slot (`takeReingestSlot`): one Workspace of an org at
 * a time, and a cap of runs on the instance. The ingestion v2 publish is the
 * normal path (ADR-047 broker, `knowledge/` only). The row is `completed`
 * when no run failed, else `failed` with the repositories that failed; the
 * operator can start it again.
 */
export function defineWorkspaceUpgradeReingest(
  options: {
    publishPipeline?: () => IngestionPublishPipeline
    /** A test gives short polls. */
    throttle?: {
      slotPoll?: "1 second" | "1 minute"
      runPoll?: "1 second" | "1 minute"
      runsPerInstance?: number
    }
  } = {},
) {
  const publishPipeline = options.publishPipeline ?? ingestionPublishPipeline
  const throttle = { ...REINGEST_THROTTLE, ...options.throttle }
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
                planReingest({
                  orgId,
                  workspaceId,
                  publishPipeline: publishPipeline(),
                }),
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
                runId: null,
                status: r.sha ? "pending" : "failed",
                report: r.sha
                  ? []
                  : ["ctx| cannot read the default branch of the repository."],
              }))
            await record("record-plan", {
              to: UPGRADE_STATUSES.running,
              upgrade: { repositories: reports, note: undefined },
            })
            for (const [index, source] of planned.repositories.entries()) {
              const report = reports[index]
              if (!source.sha || !report) continue
              const sha = source.sha
              let runId: string | null = null
              for (let poll = 0; runId === null; poll++) {
                const slot = await step.run(
                  { name: `take-slot:${index}:${poll}` },
                  () =>
                    takeReingestSlot({
                      orgId,
                      workspaceId,
                      key: reingestRunKey({
                        orgId,
                        workspaceId,
                        upgradeRunId: run.id,
                        repository: source.repository,
                      }),
                      runsPerInstance: throttle.runsPerInstance,
                      start: async () => {
                        const handle = await runWorkflowWithWorkerWake(
                          repositoryIngestionV2.spec,
                          {
                            orgId,
                            shadow: false,
                            publishPipeline: "v2",
                            source: {
                              url: source.url,
                              githubConnectionId: source.githubConnectionId,
                            },
                            sha,
                            authorTime: run.createdAt.toISOString(),
                          } satisfies IngestionV2Input,
                          {
                            idempotencyKey: reingestRunKey({
                              orgId,
                              workspaceId,
                              upgradeRunId: run.id,
                              repository: source.repository,
                            }),
                          },
                        )
                        return handle.workflowRun.id
                      },
                    }),
                )
                if ("runId" in slot) runId = slot.runId
                else
                  await step.sleep(
                    `wait-slot:${index}:${poll}`,
                    throttle.slotPoll,
                  )
              }
              report.runId = runId
              await record(`record-start:${index}`, {
                to: UPGRADE_STATUSES.running,
                upgrade: { repositories: reports },
              })
              for (let poll = 0; ; poll++) {
                const state = await step.run(
                  { name: `check-run:${index}:${poll}` },
                  () => ingestionRunState(runId),
                )
                if (state.done) {
                  Object.assign(report, runReport(state))
                  break
                }
                if (poll >= throttle.maxRunPolls) {
                  Object.assign(report, {
                    status: "failed",
                    report: ["The ingestion run did not finish in 24 hours."],
                  })
                  break
                }
                await step.sleep(`wait-run:${index}:${poll}`, throttle.runPoll)
              }
              await record(`record-run:${index}`, {
                to: UPGRADE_STATUSES.running,
                upgrade: { repositories: reports },
              })
            }
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
