import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import {
  deleteSandboxInstance,
  getSandboxInstance,
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
        id: record.key,
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
