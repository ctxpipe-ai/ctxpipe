import type { LockStore } from "@tanstack/ai/locks"
import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { withLockClient } from "../../db/client.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"

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

export async function withSandboxAdvisoryLock<T>(
  key: string,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const abort = new AbortController()
  return withLockClient(async (client) => {
    await client.query("select pg_advisory_lock(hashtextextended($1, 0))", [
      key,
    ])
    try {
      return await fn(abort.signal)
    } finally {
      abort.abort()
      try {
        await client.query(
          "select pg_advisory_unlock(hashtextextended($1, 0))",
          [key],
        )
      } catch (error) {
        log.error({
          step: "sandbox-advisory-unlock",
          sandboxKey: key,
          error: error instanceof Error ? error.message : String(error),
        })
        await client.query("select pg_advisory_unlock_all()").catch(() => {})
      }
    }
  })
}

export function postgresSandboxLockStore(_orgId: string): LockStore {
  return {
    withLock(key, fn) {
      return withSandboxAdvisoryLock(key, fn)
    },
  }
}
