import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import { parseEnv } from "../../config/env.js"
import {
  listGithubConnections,
  listGithubConnectionsForOrg,
} from "../../models/github-installation.js"
import { getLogger, log } from "../../observability/logger.js"
import { ensureGithubPrMirror } from "../../services/github/pull-request-mirror/ensure.js"
import { runWorkflowWithWorkerWake } from "../client.js"

const GithubEnsurePrMirrorInputSchema = z.object({
  orgId: z.string().min(1),
  connectionId: z.string().min(1),
  repositoryId: z.string().min(1).optional(),
  branch: z.string().min(1).optional(),
})

export const githubEnsurePrMirror = defineWorkflow(
  {
    name: "github-ensure-pr-mirror",
    schema: GithubEnsurePrMirrorInputSchema,
  },
  async ({ input }) => {
    const env = parseEnv(process.env as Record<string, string | undefined>)
    return ensureGithubPrMirror({
      orgId: input.orgId,
      connectionId: input.connectionId,
      env,
      repositoryId: input.repositoryId,
      branch: input.branch,
    })
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
    if (status !== "failed" && status !== "canceled") return
    if (failedRunIds.has(id)) {
      throw new Error(`Startup PR mirror ensure remained ${status}: ${id}`)
    }
    failedRunIds.add(id)
    idempotencyKey = `${baseKey}:retry:${id}`
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
