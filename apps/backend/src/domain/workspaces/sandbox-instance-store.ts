import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  listSandboxInstances,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import type { SandboxInstanceRecord } from "../../models/workspace-sandboxes.js"

function toTanstackRecord(
  row: SandboxInstanceRecord,
): TanstackSandboxInstanceRecord | null {
  if (!row.providerSandboxId) return null
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
}

export function postgresSandboxInstanceStore(input: {
  orgId: string
  workspaceId: string
  conversationId?: string | null
}): SandboxInstanceStore {
  return {
    async get(key) {
      const row = await getSandboxInstance(key, input.orgId)
      const keyed = row ? toTanstackRecord(row) : null
      if (keyed) return keyed
      const conversationId = input.conversationId?.trim()
      if (!conversationId) return null
      const live = await withOrgDbContext(input.orgId, () =>
        listSandboxInstances({
          conversationId,
          kind: "chat",
          state: "live",
        }),
      )
      const found = live.find((item) => item.providerSandboxId)
      return found ? toTanstackRecord(found) : null
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
