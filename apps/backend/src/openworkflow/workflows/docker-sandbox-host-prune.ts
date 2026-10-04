import { z } from "zod"
import { pruneDockerSandboxHost } from "../../domain/workspaces/docker-sandbox-host-prune.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/** The Docker host prune (see `pruneDockerSandboxHost`). */
export const dockerSandboxHostPrune = defineWorkflow(
  { name: "docker-sandbox-host-prune", schema: z.object({}) },
  async ({ step }) =>
    step.run({ name: "prune" }, () => pruneDockerSandboxHost()),
)

/**
 * Every org's sweep asks for the prune; runs are keyed by the 5-minute
 * boundary the sweeps retry on, so the host is pruned once per sweep cadence
 * however many orgs sweep in it.
 */
export async function requestDockerSandboxHostPrune(
  now: Date = new Date(),
): Promise<void> {
  const window = Math.floor(now.getTime() / (5 * 60_000))
  await runWorkflowWithWorkerWake(
    dockerSandboxHostPrune.spec,
    {},
    { idempotencyKey: `docker-sandbox-host-prune:${window}` },
  )
}
