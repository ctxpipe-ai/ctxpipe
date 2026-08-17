import type { LockStore } from "@tanstack/ai/locks"
import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../../db/client.js"
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
      await persistSandboxInstance({
        id: record.key,
        kind: "chat",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        conversationId: record.threadId,
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

export function postgresSandboxLockStore(orgId: string): LockStore {
  return {
    async withLock(key, fn) {
      const abort = new AbortController()
      return withOrgDbContext(orgId, async () => {
        const db = getOrgDb()
        return db.transaction(async (tx) => {
          await tx.execute(
            sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
          )
          return fn(abort.signal)
        })
      })
    },
  }
}
