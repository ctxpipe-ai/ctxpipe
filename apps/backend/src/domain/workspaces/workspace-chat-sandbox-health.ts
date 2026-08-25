import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  listSandboxInstances,
} from "../../models/workspaces.js"
import { getLogger } from "../../observability/logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"

export async function invalidateChatSandbox(input: {
  handle?: TanstackLikeHandle | null
  orgId: string
  conversationId: string
}): Promise<void> {
  if (input.handle) {
    await input.handle.destroy().catch((error) => {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "invalidate-chat-sandbox-destroy" },
      )
    })
  }
  const rows = await withOrgDbContext(input.orgId, () =>
    listSandboxInstances({
      conversationId: input.conversationId,
      kind: "chat",
    }),
  )
  for (const row of rows) {
    await deleteSandboxInstance(row.id, input.orgId).catch((error) => {
      getLogger().error(
        error instanceof Error ? error : new Error(String(error)),
        { step: "invalidate-chat-sandbox-row", sandboxId: row.id },
      )
    })
  }
}
