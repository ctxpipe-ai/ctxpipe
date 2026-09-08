import { defineWorkflow } from "openworkflow"
import { z } from "zod"
import {
  destroyMergeSandbox,
  mergeSandboxSchema,
} from "../../domain/workspaces/semantic-merge.js"

export const workspaceSemanticCleanup = defineWorkflow(
  {
    name: "workspace-semantic-cleanup",
    schema: z
      .object({
        orgId: z.string().min(1),
        workspaceId: z.string().min(1),
        locator: mergeSandboxSchema,
      })
      .strict(),
  },
  async ({ input, step }) => {
    await step.sleep(
      "wait-for-resource-expiry",
      `${Math.max(1, Date.parse(input.locator.expiresAt) - Date.now())}ms`,
    )
    await step.run({ name: "destroy-expired-resource" }, () =>
      destroyMergeSandbox(input.locator),
    )
    // Cancellation can race an allocation RPC whose acknowledgement is lost.
    // Native provider calls have a 30-second request timeout and reject further
    // allocation after expiry; confirm absence after that in-flight window.
    await step.sleep("settle-native-allocation", "30 seconds")
    await step.run({ name: "confirm-resource-destroyed" }, () =>
      destroyMergeSandbox(input.locator),
    )
    return { destroyed: true as const }
  },
)
