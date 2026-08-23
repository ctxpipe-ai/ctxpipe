import type { LockStore } from "@tanstack/ai/locks"
import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import { getConversation } from "../../models/conversations.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  getWorkspaceById,
  persistSandboxInstance,
} from "../../models/workspaces.js"

export function postgresSandboxInstanceStore(input: {
  orgId: string
  workspaceId: string
}): SandboxInstanceStore {
  return {
    async get(key) {
      const row = await getSandboxInstance(key, input.orgId)
      if (!row?.providerSandboxId) return null
      const record: TanstackSandboxInstanceRecord = {
        key: row.id,
        provider: row.provider ?? "",
        providerSandboxId: row.providerSandboxId,
        threadId: row.conversationId ?? "",
        updatedAt: row.lastHeartbeatAt.getTime(),
      }
      if (row.latestSnapshotId) record.latestSnapshotId = row.latestSnapshotId
      if (row.latestRunId) record.latestRunId = row.latestRunId
      return record
    },
    async upsert(record) {
      const conversationId = record.threadId.trim() || null
      await persistSandboxInstance({
        id: conversationId ?? record.key,
        kind: "chat",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        conversationId,
        provider: record.provider,
        providerSandboxId: record.providerSandboxId,
        latestSnapshotId: record.latestSnapshotId ?? null,
        latestRunId: record.latestRunId ?? null,
        state: "live",
        lastHeartbeatAt: new Date(record.updatedAt),
      })
    },
    async delete(key) {
      await deleteSandboxInstance(key, input.orgId)
    },
  }
}

export function postgresSandboxLockStore(input: {
  orgId: string
  workspaceId: string
  conversationId?: string
}): LockStore {
  return {
    async withLock(_key, fn) {
      const abort = new AbortController()
      await withOrgDbContext(input.orgId, async () => {
        const workspace = await getWorkspaceById(input.workspaceId)
        if (!workspace) {
          throw new Error(
            `Workspace ${input.workspaceId} is gone; refusing sandbox create`,
          )
        }
        if (!input.conversationId) return
        const conversation = await getConversation(input.conversationId, {
          workspaceId: input.workspaceId,
        })
        if (!conversation) {
          throw new Error(
            `Conversation ${input.conversationId} is gone; refusing sandbox create`,
          )
        }
      })
      try {
        return await fn(abort.signal)
      } finally {
        abort.abort()
      }
    },
  }
}
