import { z } from "zod"
import { pruneDockerSandboxHost } from "../../domain/workspaces/docker-sandbox-host-prune.js"
import { discoverSandboxProvider } from "../../domain/workspaces/sandbox-provider.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

const PRUNE_WINDOW_MS = 60 * 60_000

/** The Docker host prune (see `pruneDockerSandboxHost`). */
export const dockerSandboxHostPrune = defineWorkflow(
  { name: "docker-sandbox-host-prune", schema: z.object({}) },
  async ({ step }) =>
    step.run({ name: "prune" }, () => pruneDockerSandboxHost()),
)

/**
 * At most one prune per hour. Requested at worker start and by every
 * conversation sandbox sweep, so it runs while the host is in use (when its
 * disk can grow) without a scheduler of its own. Only Docker deployments
 * prune.
 */
export async function requestDockerSandboxHostPrune(
  now: Date = new Date(),
): Promise<void> {
  if ((await discoverSandboxProvider().catch(() => undefined)) !== "docker")
    return
  const window = Math.floor(now.getTime() / PRUNE_WINDOW_MS)
  await runWorkflowWithWorkerWake(
    dockerSandboxHostPrune.spec,
    {},
    { idempotencyKey: `docker-sandbox-host-prune:${window}` },
  )
}
