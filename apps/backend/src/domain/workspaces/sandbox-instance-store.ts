import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { and, eq } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import { workspaces } from "../../db/schema/workspaces.js"
import type { SandboxInstanceRecord } from "../../models/workspace-sandboxes.js"
import {
  type SandboxInstanceDeleteOwnership,
  type SandboxInstanceOwnership,
  SandboxInstanceOwnershipConflict,
} from "../../models/workspace-sandboxes.js"
import {
  deleteSandboxInstance,
  getSandboxInstance,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import { sameWorkspaceBinding, type WorkspaceRevision } from "./revision.js"
import {
  markSandboxLifecycle,
  timeSandboxLifecycle,
} from "./sandbox-lifecycle-timing.js"

/** Native instance-store access for warm-turn attach proof. */
export const workspaceChatInstanceAccess = {
  hits: 0,
  creates: 0,
  reset() {
    this.hits = 0
    this.creates = 0
  },
}

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

function ownershipOf(row: SandboxInstanceRecord): SandboxInstanceOwnership {
  return {
    kind: row.kind,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    provider: row.provider,
    image: row.image,
    revision: row.revision,
  }
}

/**
 * TanStack's instance store over `workspace_sandbox_instances`. A conversation
 * keeps one sandbox while the default branch moves, so ownership checks compare
 * the Workspace binding, not the commit. The row's revision records the commit
 * the sandbox is on; only the pre-turn update advances it.
 */
export function postgresSandboxInstanceStore(input: {
  orgId: string
  workspaceId: string
  /** Production always passes these; the TanStack conformance suite omits them. */
  conversationId?: string
  revision?: WorkspaceRevision
  image?: string
  provider?: string
}): SandboxInstanceStore {
  function assertOwnedRecord(key: string, row: SandboxInstanceRecord): void {
    if (
      row.orgId !== input.orgId ||
      row.workspaceId !== input.workspaceId ||
      row.kind !== "chat" ||
      (input.conversationId !== undefined &&
        (row.conversationId ?? null) !== input.conversationId) ||
      (input.provider !== undefined && row.provider !== input.provider) ||
      (input.image !== undefined && row.image !== input.image) ||
      (input.revision !== undefined &&
        (!row.revision || !sameWorkspaceBinding(row.revision, input.revision)))
    ) {
      throw new SandboxInstanceOwnershipConflict(key)
    }
  }

  return {
    async get(key) {
      const conversationId = input.conversationId
      return withOrgDbContext(input.orgId, async (db) => {
        if (conversationId !== undefined) {
          const rows = await timeSandboxLifecycle(
            "store-get-conversation",
            () =>
              db
                .select({ id: conversations.id })
                .from(conversations)
                .innerJoin(
                  workspaces,
                  and(
                    eq(workspaces.id, conversations.workspaceId),
                    eq(workspaces.orgId, conversations.orgId),
                  ),
                )
                .where(
                  and(
                    eq(conversations.id, conversationId),
                    eq(conversations.orgId, input.orgId),
                    eq(workspaces.id, input.workspaceId),
                  ),
                )
                .limit(1),
            { key },
          )
          if (!rows.length)
            throw new Error("Conversation workspace is no longer available")
        }
        const row = await timeSandboxLifecycle(
          "store-get-instance",
          () => getSandboxInstance(key, input.orgId),
          { key },
        )
        markSandboxLifecycle("store-get-result", { key, hit: row != null })
        if (!row) return null
        assertOwnedRecord(key, row)
        workspaceChatInstanceAccess.hits += 1
        return toTanstackRecord(row)
      })
    },
    async upsert(record) {
      if (
        (input.conversationId !== undefined &&
          record.threadId !== input.conversationId) ||
        (input.provider !== undefined && record.provider !== input.provider)
      )
        throw new SandboxInstanceOwnershipConflict(record.key)
      await withOrgDbContext(input.orgId, async () => {
        const existing = await timeSandboxLifecycle(
          "store-upsert-lookup",
          () => getSandboxInstance(record.key, input.orgId),
          { key: record.key },
        )
        if (existing) assertOwnedRecord(record.key, existing)
        else workspaceChatInstanceAccess.creates += 1
        const persisted: SandboxInstanceRecord = {
          id: record.key,
          kind: "chat",
          orgId: input.orgId,
          workspaceId: input.workspaceId,
          conversationId: record.threadId.trim() || null,
          provider: record.provider,
          providerSandboxId: record.providerSandboxId,
          image: input.image ?? null,
          // A new sandbox starts on the desired commit; an existing one keeps
          // the commit it is on until the pre-turn update moves it.
          revision: existing?.revision ?? input.revision ?? null,
          latestSnapshotId: record.latestSnapshotId ?? null,
          latestRunId: record.latestRunId ?? null,
          state: "live",
          lastHeartbeatAt: new Date(record.updatedAt),
        }
        await timeSandboxLifecycle(
          "store-upsert-persist",
          () =>
            persistSandboxInstance(
              persisted,
              existing ? ownershipOf(existing) : undefined,
            ),
          { key: persisted.id },
        )
      })
    },
    async delete(key) {
      const row = await getSandboxInstance(key, input.orgId)
      if (!row) return
      assertOwnedRecord(key, row)
      const expected: SandboxInstanceDeleteOwnership = {
        ...ownershipOf(row),
        providerSandboxId: row.providerSandboxId,
      }
      await deleteSandboxInstance(key, input.orgId, expected)
    },
  }
}
