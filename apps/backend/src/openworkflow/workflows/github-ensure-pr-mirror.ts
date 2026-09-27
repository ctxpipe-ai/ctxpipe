import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import { withOrgDbContext } from "../../db/client.js"
import {
  listGithubConnections,
  listGithubConnectionsForOrg,
} from "../../models/github-installation.js"
import {
  getGithubPrMirrorBinding,
  patchGithubPrMirror,
} from "../../models/github-pr-mirror.js"
import { getLogger, log } from "../../observability/logger.js"
import {
  planGithubPrMirrorEnsure,
  recordGithubPrMirrorEnsureFailure,
} from "../../services/github/pull-request-mirror/ensure.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"
import { isWorkflowControlSignal } from "../isSleepSignal.js"
import { enqueueGithubPrMirrorContent } from "./github-sync-content.js"
import { workspaceConnectorMirror } from "./workspace-connector-mirror.js"

const GithubEnsurePrMirrorInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  repositoryId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
})

function configMirrorCommitSha(
  result: unknown,
  fallbackCommitSha: string,
): string {
  if (result && typeof result === "object" && "commitSha" in result) {
    const commitSha = (result as { commitSha?: string }).commitSha
    if (commitSha) return commitSha
  }
  return fallbackCommitSha
}

export const githubEnsurePrMirror = defineWorkflow(
  {
    name: "github-ensure-pr-mirror",
    schema: GithubEnsurePrMirrorInputSchema,
  },
  async ({ input, step }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    let ensureGeneration: number | undefined
    try {
      const plan = await step.run({ name: "plan-github-pr-mirror" }, () =>
        planGithubPrMirrorEnsure({
          orgId: input.orgId,
          connectionId: input.connectionId,
          env,
          repositoryId: input.repositoryId,
          branch: input.branch,
        }),
      )
      if (plan.status === "retry_content") {
        await step.run({ name: "enqueue-github-pr-content" }, () =>
          enqueueGithubPrMirrorContent({
            orgId: input.orgId,
            connectionId: input.connectionId,
            commitSha: plan.commitSha,
            ...(plan.launchToken ? { launchToken: plan.launchToken } : {}),
          }),
        )
        return { status: "started" as const }
      }
      if (plan.status !== "write_config") return { status: plan.status }
      const claimed = await step.run(
        { name: "claim-github-pr-ensure-stage" },
        () =>
          patchGithubPrMirror({
            orgId: input.orgId,
            connectionId: input.connectionId,
            claimEnsureStage: true,
            expectedContentSyncGeneration: plan.contentSyncGeneration,
            patch: {
              lastContentCommitSha: null,
              lastContentLaunchToken: null,
            },
          }),
      )
      if (!claimed.applied) return { status: "superseded" as const }
      ensureGeneration = claimed.contentSyncGeneration
      const result = await step.runWorkflow(
        workspaceConnectorMirror.spec,
        plan.mirrorInput,
        { name: "commit-github-pr-config" },
      )
      const commitSha = configMirrorCommitSha(result, plan.fallbackCommitSha)
      await step.run({ name: "enqueue-github-pr-content" }, () =>
        enqueueGithubPrMirrorContent({
          orgId: input.orgId,
          connectionId: input.connectionId,
          commitSha,
        }),
      )
      return { status: "started" as const }
    } catch (error) {
      if (isWorkflowControlSignal(error)) throw error
      if (ensureGeneration != null) {
        await recordGithubPrMirrorEnsureFailure({
          orgId: input.orgId,
          connectionId: input.connectionId,
          expectedContentSyncGeneration: ensureGeneration,
        })
      }
      throw error
    }
  },
)

export async function enqueueGithubPrMirrorEnsureForOrg(
  orgId: string,
): Promise<void> {
  const connections = await listGithubConnectionsForOrg(orgId)
  for (const connection of connections) {
    try {
      await runWorkflowWithWorkerWake(githubEnsurePrMirror.spec, {
        orgId,
        connectionId: connection.id,
      })
    } catch (error) {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        {
          step: "github.pr-mirror.ensure.enqueue",
          connectionId: connection.id,
        },
      )
    }
  }
}

async function enqueueStartupEnsure(input: {
  orgId: string
  connectionId: string
}): Promise<void> {
  // OpenWorkflow retains idempotency keys for 24 hours, coalescing deploy
  // restart storms without disabling reconciliation on later process starts.
  const baseKey = `github-pr-mirror-startup:v1:${input.orgId}:${input.connectionId}`
  let idempotencyKey = baseKey
  const failedRunIds = new Set<string>()
  for (;;) {
    const handle = await runWorkflowWithWorkerWake(
      githubEnsurePrMirror.spec,
      input,
      { idempotencyKey },
    )
    const { id, status } = handle.workflowRun
    if (status === "failed" || status === "canceled") {
      if (failedRunIds.has(id)) {
        throw new Error(`Startup PR mirror ensure remained ${status}: ${id}`)
      }
      failedRunIds.add(id)
      idempotencyKey = `${baseKey}:retry:${id}`
      continue
    }
    if (status !== "completed") return
    const binding = await withOrgDbContext(input.orgId, () =>
      getGithubPrMirrorBinding(input.orgId, input.connectionId),
    )
    if (binding?.setupPhase !== "sync_failed") return
    if (binding.lastContentCommitSha) {
      await enqueueGithubPrMirrorContent({
        orgId: input.orgId,
        connectionId: input.connectionId,
        commitSha: binding.lastContentCommitSha,
        launchToken: binding.lastContentLaunchToken ?? undefined,
      })
      return
    }
    idempotencyKey = `${baseKey}:retry:sync_failed`
    if (failedRunIds.has("sync_failed")) {
      throw new Error(
        `Startup PR mirror ensure remained sync_failed without a content commit: ${id}`,
      )
    }
    failedRunIds.add("sync_failed")
  }
}

export async function enqueueGithubPrMirrorEnsureSweep(): Promise<number> {
  const connections = await listGithubConnections()
  for (const connection of connections) {
    try {
      await enqueueStartupEnsure({
        orgId: connection.orgId,
        connectionId: connection.id,
      })
    } catch (error) {
      const normalized =
        error instanceof Error ? error : new Error(String(error))
      log.error({
        step: "github.pr-mirror.ensure.sweep.enqueue",
        connectionId: connection.id,
        orgId: connection.orgId,
        message: normalized.message,
      })
    }
  }
  return connections.length
}

const sweepOnceKey = "__ctxpipeGithubPrMirrorSweepStarted"

export function startGithubPrMirrorEnsureSweepOnce(): void {
  const state = globalThis as typeof globalThis & {
    [sweepOnceKey]?: boolean
  }
  if (state[sweepOnceKey]) return
  state[sweepOnceKey] = true
  void enqueueGithubPrMirrorEnsureSweep().catch((error) => {
    const normalized = error instanceof Error ? error : new Error(String(error))
    log.error({
      step: "github.pr-mirror.ensure.sweep",
      message: normalized.message,
    })
  })
}
