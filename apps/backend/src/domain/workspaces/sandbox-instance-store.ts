import { AsyncLocalStorage } from "node:async_hooks"
import type { LockStore } from "@tanstack/ai/locks"
import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { withLockClient, withOrgDbContext } from "../../db/client.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  getWorkspaceById,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { log } from "../../observability/logger.js"

const heldSandboxLocks = new AsyncLocalStorage<Set<string>>()

export function workspaceSandboxLockKey(workspaceId: string): string {
  return `sandbox:job:${workspaceId}`
}

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
  const held = heldSandboxLocks.getStore()
  if (held?.has(key)) {
    return fn(new AbortController().signal)
  }
  const nextHeld = new Set(held)
  nextHeld.add(key)
  const abort = new AbortController()
  return heldSandboxLocks.run(nextHeld, () =>
    withLockClient(async (client) => {
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
    }),
  )
}

export function postgresSandboxLockStore(input: {
  orgId: string
  workspaceId: string
}): LockStore {
  const workspaceKey = workspaceSandboxLockKey(input.workspaceId)
  return {
    withLock(key, fn) {
      return withSandboxAdvisoryLock(workspaceKey, async (signal) => {
        const workspace = await withOrgDbContext(input.orgId, () =>
          getWorkspaceById(input.workspaceId),
        )
        if (!workspace) {
          throw new Error(
            `Workspace ${input.workspaceId} is gone; refusing sandbox create`,
          )
        }
        return key === workspaceKey
          ? fn(signal)
          : withSandboxAdvisoryLock(key, () => fn(signal))
      })
    },
  }
}
