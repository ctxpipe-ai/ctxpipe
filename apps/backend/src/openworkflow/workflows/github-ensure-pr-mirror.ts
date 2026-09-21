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

export async function enqueueGithubPrMirrorEnsureSweep(): Promise<number> {
  const connections = await listGithubConnections()
  for (const connection of connections) {
    try {
      await runWorkflowWithWorkerWake(githubEnsurePrMirror.spec, {
        orgId: connection.orgId,
        connectionId: connection.id,
      })
    } catch (error) {
      log.error(error instanceof Error ? error : new Error(String(error)), {
        step: "github.pr-mirror.ensure.sweep.enqueue",
        connectionId: connection.id,
        orgId: connection.orgId,
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
    log.error(error instanceof Error ? error : new Error(String(error)), {
      step: "github.pr-mirror.ensure.sweep",
    })
  })
}
