import { and, asc, desc, eq, isNotNull, lte } from "drizzle-orm"
import type { ModelMessage } from "@tanstack/ai"
import {
  composePersistence,
  defineAIPersistence,
  memoryPersistence,
  type ChatPersistence,
  type InterruptRecord,
  type InterruptStore,
  type MessageStore,
  type MetadataStore,
  type RunRecord,
  type RunStore,
} from "@tanstack/ai-persistence"
import { requireCurrentOrgId } from "../../auth/context.js"
import { getOrgDb } from "../../db/client.js"
import {
  chatInterrupts,
  chatMetadata,
  chatRuns,
  chatThreads,
} from "../../db/schema/chat-persistence.js"
import { withAmbientOrgDb } from "../../db/org-sql.js"

function orgSql<T>(fn: () => Promise<T>): Promise<T> {
  return withAmbientOrgDb(fn)
}

function mapRun(row: typeof chatRuns.$inferSelect): RunRecord {
  return {
    runId: row.runId,
    threadId: row.threadId,
    status: row.status as RunRecord["status"],
    startedAt: row.startedAt,
    ...(row.finishedAt != null ? { finishedAt: row.finishedAt } : {}),
    ...(row.error != null
      ? {
          error: {
            message: row.error,
            ...(row.errorCode != null ? { code: row.errorCode } : {}),
          },
        }
      : {}),
    ...(row.usageJson != null
      ? { usage: row.usageJson as unknown as RunRecord["usage"] }
      : {}),
    ...(row.sandboxKey != null ? { sandboxKey: row.sandboxKey } : {}),
    ...(row.detachedSince != null ? { detachedSince: row.detachedSince } : {}),
    ...(row.cancelRequested != null
      ? { cancelRequested: row.cancelRequested }
      : {}),
    ...(row.driverEpoch != null ? { driverEpoch: row.driverEpoch } : {}),
  }
}

function mapInterrupt(row: typeof chatInterrupts.$inferSelect): InterruptRecord {
  return {
    interruptId: row.interruptId,
    runId: row.runId,
    threadId: row.threadId,
    status: row.status as InterruptRecord["status"],
    requestedAt: row.requestedAt,
    payload: row.payloadJson,
    ...(row.resolvedAt != null ? { resolvedAt: row.resolvedAt } : {}),
    ...(row.responseJson != null ? { response: row.responseJson } : {}),
  }
}

function createMessageStore(): MessageStore {
  return {
    async loadThread(threadId) {
      return orgSql(async () => {
        const rows = await getOrgDb()
          .select({ messagesJson: chatThreads.messagesJson })
          .from(chatThreads)
          .where(eq(chatThreads.threadId, threadId))
          .limit(1)
        return (rows[0]?.messagesJson ?? []) as ModelMessage[]
      })
    },
    async saveThread(threadId, messages) {
      return orgSql(async () => {
        const orgId = requireCurrentOrgId()
        const updatedAt = Date.now()
        await getOrgDb()
          .insert(chatThreads)
          .values({
            threadId,
            orgId,
            messagesJson: messages,
            updatedAt,
          })
          .onConflictDoUpdate({
            target: chatThreads.threadId,
            set: { messagesJson: messages, updatedAt },
          })
      })
    },
  }
}

function createRunStore(): RunStore {
  async function get(runId: string) {
    return orgSql(async () => {
      const rows = await getOrgDb()
        .select()
        .from(chatRuns)
        .where(eq(chatRuns.runId, runId))
        .limit(1)
      return rows[0] ? mapRun(rows[0]) : null
    })
  }

  return {
    get,
    async createOrResume({ runId, threadId, startedAt, status }) {
      const existing = await get(runId)
      if (existing) return existing
      await orgSql(async () => {
        const orgId = requireCurrentOrgId()
        await getOrgDb()
          .insert(chatRuns)
          .values({
            runId,
            threadId,
            orgId,
            status: status ?? "running",
            startedAt,
          })
          .onConflictDoNothing({ target: chatRuns.runId })
      })
      const stored = await get(runId)
      return (
        stored ?? { runId, threadId, status: status ?? "running", startedAt }
      )
    },
    async update(runId, patch) {
      const set: Partial<typeof chatRuns.$inferInsert> = {}
      if (patch.status !== undefined) set.status = patch.status
      if (patch.finishedAt !== undefined) set.finishedAt = patch.finishedAt
      if (patch.error !== undefined) {
        set.error = patch.error.message
        set.errorCode = patch.error.code ?? null
      }
      if (patch.usage !== undefined) {
        set.usageJson = patch.usage as unknown as Record<string, unknown>
      }
      if ("sandboxKey" in patch) set.sandboxKey = patch.sandboxKey ?? null
      if ("detachedSince" in patch) {
        set.detachedSince = patch.detachedSince ?? null
      }
      if ("cancelRequested" in patch) {
        set.cancelRequested = patch.cancelRequested ?? null
      }
      if ("driverEpoch" in patch) set.driverEpoch = patch.driverEpoch ?? null
      if (Object.keys(set).length === 0) return
      await orgSql(async () => {
        await getOrgDb().update(chatRuns).set(set).where(eq(chatRuns.runId, runId))
      })
    },
    async findActiveRun(threadId) {
      return orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatRuns)
          .where(
            and(eq(chatRuns.threadId, threadId), eq(chatRuns.status, "running")),
          )
          .orderBy(desc(chatRuns.startedAt))
          .limit(1)
        return rows[0] ? mapRun(rows[0]) : null
      })
    },
    async listByThread(threadId) {
      return orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatRuns)
          .where(eq(chatRuns.threadId, threadId))
          .orderBy(asc(chatRuns.startedAt))
        return rows.map(mapRun)
      })
    },
    async listReclaimable({ now, ttlMs }) {
      return orgSql(async () => {
        const cutoff = now - ttlMs
        const rows = await getOrgDb()
          .select()
          .from(chatRuns)
          .where(
            and(
              eq(chatRuns.status, "running"),
              isNotNull(chatRuns.detachedSince),
              lte(chatRuns.detachedSince, cutoff),
            ),
          )
        return rows.map(mapRun)
      })
    },
  }
}

function createInterruptStore(): InterruptStore {
  return {
    async create(record) {
      await orgSql(async () => {
        const orgId = requireCurrentOrgId()
        await getOrgDb()
          .insert(chatInterrupts)
          .values({
            interruptId: record.interruptId,
            runId: record.runId,
            threadId: record.threadId,
            orgId,
            status: "pending",
            requestedAt: record.requestedAt,
            payloadJson: record.payload,
            ...(record.response !== undefined
              ? { responseJson: record.response }
              : {}),
          })
          .onConflictDoNothing({ target: chatInterrupts.interruptId })
      })
    },
    async resolve(interruptId, response) {
      await orgSql(async () => {
        await getOrgDb()
          .update(chatInterrupts)
          .set({
            status: "resolved",
            resolvedAt: Date.now(),
            ...(response !== undefined ? { responseJson: response } : {}),
          })
          .where(eq(chatInterrupts.interruptId, interruptId))
      })
    },
    async cancel(interruptId) {
      await orgSql(async () => {
        await getOrgDb()
          .update(chatInterrupts)
          .set({ status: "cancelled", resolvedAt: Date.now() })
          .where(eq(chatInterrupts.interruptId, interruptId))
      })
    },
    async get(interruptId) {
      return orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatInterrupts)
          .where(eq(chatInterrupts.interruptId, interruptId))
          .limit(1)
        return rows[0] ? mapInterrupt(rows[0]) : null
      })
    },
    list: (threadId) =>
      orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatInterrupts)
          .where(eq(chatInterrupts.threadId, threadId))
          .orderBy(asc(chatInterrupts.requestedAt))
        return rows.map(mapInterrupt)
      }),
    listPending: (threadId) =>
      orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatInterrupts)
          .where(
            and(
              eq(chatInterrupts.threadId, threadId),
              eq(chatInterrupts.status, "pending"),
            ),
          )
          .orderBy(asc(chatInterrupts.requestedAt))
        return rows.map(mapInterrupt)
      }),
    listByRun: (runId) =>
      orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatInterrupts)
          .where(eq(chatInterrupts.runId, runId))
          .orderBy(asc(chatInterrupts.requestedAt))
        return rows.map(mapInterrupt)
      }),
    listPendingByRun: (runId) =>
      orgSql(async () => {
        const rows = await getOrgDb()
          .select()
          .from(chatInterrupts)
          .where(
            and(
              eq(chatInterrupts.runId, runId),
              eq(chatInterrupts.status, "pending"),
            ),
          )
          .orderBy(asc(chatInterrupts.requestedAt))
        return rows.map(mapInterrupt)
      }),
  }
}

function createMetadataStore(): MetadataStore {
  return {
    async get(namespace, key) {
      return orgSql(async () => {
        const rows = await getOrgDb()
          .select({ valueJson: chatMetadata.valueJson })
          .from(chatMetadata)
          .where(
            and(
              eq(chatMetadata.namespace, namespace),
              eq(chatMetadata.key, key),
            ),
          )
          .limit(1)
        return rows[0]?.valueJson ?? null
      })
    },
    async set(namespace, key, value) {
      if (value == null) {
        throw new TypeError(
          `Cannot store ${value} for (${namespace}, ${key}) — use delete() to clear metadata.`,
        )
      }
      await orgSql(async () => {
        const orgId = requireCurrentOrgId()
        await getOrgDb()
          .insert(chatMetadata)
          .values({ namespace, key, orgId, valueJson: value })
          .onConflictDoUpdate({
            target: [chatMetadata.namespace, chatMetadata.key],
            set: { valueJson: value },
          })
      })
    },
    async delete(namespace, key) {
      await orgSql(async () => {
        await getOrgDb()
          .delete(chatMetadata)
          .where(
            and(
              eq(chatMetadata.namespace, namespace),
              eq(chatMetadata.key, key),
            ),
          )
      })
    },
  }
}

const chatStores: ChatPersistence = defineAIPersistence({
  stores: {
    messages: createMessageStore(),
    runs: createRunStore(),
    interrupts: createInterruptStore(),
    metadata: createMetadataStore(),
  },
})

/** Postgres transcript/runs plus in-memory artifacts/blobs for sandbox snapshots. */
export function workspaceChatPersistence() {
  const memory = memoryPersistence()
  return composePersistence(memory, {
    overrides: {
      messages: chatStores.stores.messages,
      runs: chatStores.stores.runs,
      interrupts: chatStores.stores.interrupts,
      metadata: chatStores.stores.metadata,
    },
  })
}
