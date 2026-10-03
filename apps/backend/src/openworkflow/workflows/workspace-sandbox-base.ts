import { z } from "zod"
import { buildWorkspaceSandboxBase } from "../../domain/workspaces/workspace-sandbox-base.js"
import { collectUnusedWorkspaceChatBases } from "../../domain/workspaces/workspace-sandbox-cleanup.js"
import { log } from "../../observability/logger.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/** Requests within one window share a run; a failed build is retried in the next. */
const REQUEST_WINDOW_MS = 10 * 60_000

/**
 * Build (or refresh) one Workspace's base, then delete the bases it
 * supersedes once nothing uses them. Requested by conversation starts that
 * found no current base; the build itself decides whether one is needed.
 */
export const workspaceSandboxBase = defineWorkflow(
  {
    name: "workspace-sandbox-base",
    schema: z.object({
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
    }),
  },
  async ({ input, step }) => {
    // A failure is not retried here: the next new conversation asks again.
    const built = await step.run({ name: "build" }, async () => {
      try {
        return await buildWorkspaceSandboxBase(input)
      } catch (error) {
        log.error({
          step: "workspace-base-build",
          message: `Building the Workspace base failed: ${String(error)}`,
          orgId: input.orgId,
          workspaceId: input.workspaceId,
        })
        return "failed" as const
      }
    })
    const deleted = await step.run({ name: "collect" }, () =>
      collectUnusedWorkspaceChatBases(input.orgId, input.workspaceId),
    )
    return { built, deleted }
  },
)

/** Ask for a base build; concurrent starts in one Workspace share one run. */
export async function requestWorkspaceSandboxBase(
  orgId: string,
  workspaceId: string,
  now: Date = new Date(),
): Promise<void> {
  const window = Math.floor(now.getTime() / REQUEST_WINDOW_MS)
  await runWorkflowWithWorkerWake(
    workspaceSandboxBase.spec,
    { orgId, workspaceId },
    { idempotencyKey: `workspace-sandbox-base:${workspaceId}:${window}` },
  )
}
