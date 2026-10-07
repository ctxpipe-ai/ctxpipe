import { z } from "zod"
import {
  agentVaultAccess,
  sweepRunVaults,
} from "../../domain/workspaces/agent-vault.js"
import { RUN_VAULT_TTL_SECONDS } from "../../domain/workspaces/docker-run-vault.js"
import { pruneDockerSandboxHost } from "../../domain/workspaces/docker-sandbox-host-prune.js"
import { runWorkflowWithWorkerWake } from "../client.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The Docker host prune (see `pruneDockerSandboxHost`), and the sweep of run
 * vaults that turn ends did not delete (one Agent Vault per deployment, so
 * once per window, not once per org).
 */
export const dockerSandboxHostPrune = defineWorkflow(
  { name: "docker-sandbox-host-prune", schema: z.object({}) },
  async ({ step }) => {
    await step.run({ name: "prune" }, () => pruneDockerSandboxHost())
    await step.run({ name: "agent-vault-sweep" }, async () => {
      const access = agentVaultAccess()
      // Their sessions have ended; the run-token sweep revokes the tokens.
      if (access) await sweepRunVaults(access, RUN_VAULT_TTL_SECONDS * 1000)
    })
  },
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
