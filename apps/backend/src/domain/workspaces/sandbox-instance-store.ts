import type {
  SandboxInstanceStore,
  SandboxInstanceRecord as TanstackSandboxInstanceRecord,
} from "@tanstack/ai-sandbox"
import { and, desc, eq, isNull } from "drizzle-orm"
import { withOrgDbContext } from "../../db/client.js"
import { conversations } from "../../db/schema/conversations.js"
import {
  workspaceSandboxInstances,
  workspaces,
} from "../../db/schema/workspaces.js"
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
import { sameWorkspaceRevision, type WorkspaceRevision } from "./revision.js"

export class LegacyWorkspaceSandboxConflict extends Error {
  constructor(recordId: string, providerSandboxId: string | null) {
    super(
      `Legacy conversation worktree ${recordId} (provider ${providerSandboxId ?? "unknown"}) requires recovery before its sandbox configuration can change. Its saved edits have been retained.`,
    )
  }
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
  if (row.transitionKey) record.transitionKey = row.transitionKey
  return record
}

export function postgresSandboxInstanceStore(input: {
  orgId: string
  workspaceId: string
  conversationId?: string | null
  revision?: WorkspaceRevision
  image?: string | null
  provider?: string
}): SandboxInstanceStore {
  function expectedConversation(key: string): string | null | undefined {
    if (key.startsWith("base:")) return null
    return input.conversationId
  }

  function revisionsMatch(
    actual: WorkspaceRevision | null | undefined,
    expected: WorkspaceRevision | null | undefined,
  ): boolean {
    if (!actual || !expected) return actual == null && expected == null
    return sameWorkspaceRevision(actual, expected)
  }

  function assertOwnedRecord(
    key: string,
    row: SandboxInstanceRecord,
    options: { allowPreviousRevision?: boolean } = {},
  ): void {
    const conversationId = expectedConversation(key)
    const isBase = key.startsWith("base:")
    if (
      row.orgId !== input.orgId ||
      row.workspaceId !== input.workspaceId ||
      row.kind !== "chat" ||
      isBase !== (row.conversationId == null) ||
      (conversationId !== undefined &&
        (row.conversationId ?? null) !== conversationId) ||
      (input.provider !== undefined && row.provider !== input.provider) ||
      (input.image !== undefined && row.image !== input.image) ||
      (!options.allowPreviousRevision &&
        input.revision !== undefined &&
        !revisionsMatch(row.revision, input.revision))
    ) {
      throw new SandboxInstanceOwnershipConflict(key)
    }
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

  function deleteOwnershipOf(
    row: SandboxInstanceRecord,
  ): SandboxInstanceDeleteOwnership {
    return { ...ownershipOf(row), providerSandboxId: row.providerSandboxId }
  }

  return {
    async findByTransitionKey(key) {
      if (!input.conversationId || !input.provider || input.image === undefined)
        throw new Error(
          "Sandbox transition lookup requires conversation, provider, and image ownership",
        )
      const [row] = await withOrgDbContext(input.orgId, (db) =>
        db
          .select()
          .from(workspaceSandboxInstances)
          .where(
            and(
              eq(workspaceSandboxInstances.orgId, input.orgId),
              eq(workspaceSandboxInstances.workspaceId, input.workspaceId),
              eq(
                workspaceSandboxInstances.conversationId,
                input.conversationId ?? "",
              ),
              eq(workspaceSandboxInstances.kind, "chat"),
              eq(workspaceSandboxInstances.transitionKey, key),
              eq(workspaceSandboxInstances.state, "live"),
            ),
          )
          .orderBy(desc(workspaceSandboxInstances.lastHeartbeatAt))
          .limit(1),
      )
      if (row) {
        const record = { ...row, kind: "chat" as const, state: "live" as const }
        assertOwnedRecord(record.id, record, { allowPreviousRevision: true })
        return toTanstackRecord(record)
      }
      if (input.conversationId) {
        const [legacy] = await withOrgDbContext(input.orgId, (db) =>
          db
            .select({
              id: workspaceSandboxInstances.id,
              providerSandboxId: workspaceSandboxInstances.providerSandboxId,
            })
            .from(workspaceSandboxInstances)
            .where(
              and(
                eq(workspaceSandboxInstances.orgId, input.orgId),
                eq(workspaceSandboxInstances.workspaceId, input.workspaceId),
                eq(
                  workspaceSandboxInstances.conversationId,
                  input.conversationId ?? "",
                ),
                eq(workspaceSandboxInstances.kind, "chat"),
                eq(workspaceSandboxInstances.state, "live"),
                isNull(workspaceSandboxInstances.transitionKey),
              ),
            )
            .limit(1),
        )
        if (legacy)
          throw new LegacyWorkspaceSandboxConflict(
            legacy.id,
            legacy.providerSandboxId,
          )
      }
      return null
    },
    async move(fromKey, record) {
      const { provider, image } = input
      if (
        !input.conversationId ||
        !provider ||
        image === undefined ||
        input.revision?.workspaceId !== input.workspaceId ||
        record.threadId !== input.conversationId ||
        record.provider !== provider
      ) {
        throw new SandboxInstanceOwnershipConflict(fromKey)
      }
      const moved = await withOrgDbContext(input.orgId, (db) =>
        db.transaction(async (tx) => {
          const revision = input.revision
          if (revision) {
            const current = await tx
              .select({ id: workspaces.id })
              .from(workspaces)
              .where(
                and(
                  eq(workspaces.id, revision.workspaceId),
                  eq(workspaces.orgId, input.orgId),
                  eq(workspaces.desiredSha, revision.sha),
                  eq(workspaces.desiredGeneration, revision.generation),
                  eq(workspaces.workspaceRepositoryUrl, revision.remote.url),
                  revision.remote.connectionId === null
                    ? isNull(workspaces.githubConnectionId)
                    : eq(
                        workspaces.githubConnectionId,
                        revision.remote.connectionId,
                      ),
                  eq(workspaces.desiredDefaultBranch, revision.defaultBranch),
                ),
              )
              .for("share")
            if (!current.length)
              throw new Error(
                "Workspace revision changed before sandbox ownership moved",
              )
          }
          return tx
            .update(workspaceSandboxInstances)
            .set({
              id: record.key,
              transitionKey: record.transitionKey ?? null,
              revision: input.revision ?? null,
              provider: record.provider,
              providerSandboxId: record.providerSandboxId,
              image: image ?? null,
              latestRunId: record.latestRunId ?? null,
              latestSnapshotId: record.latestSnapshotId ?? null,
              lastHeartbeatAt: new Date(record.updatedAt),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(workspaceSandboxInstances.id, fromKey),
                eq(workspaceSandboxInstances.orgId, input.orgId),
                eq(workspaceSandboxInstances.workspaceId, input.workspaceId),
                eq(workspaceSandboxInstances.conversationId, record.threadId),
                eq(workspaceSandboxInstances.kind, "chat"),
                eq(workspaceSandboxInstances.provider, provider),
                image === null
                  ? isNull(workspaceSandboxInstances.image)
                  : eq(workspaceSandboxInstances.image, image),
                eq(
                  workspaceSandboxInstances.transitionKey,
                  record.transitionKey ?? "",
                ),
                eq(workspaceSandboxInstances.state, "live"),
              ),
            )
            .returning({ id: workspaceSandboxInstances.id })
        }),
      )
      if (moved.length !== 1)
        throw new Error("Sandbox transition lost its previous owner")
    },
    async get(key) {
      if (input.conversationId) {
        const rows = await withOrgDbContext(input.orgId, (db) =>
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
                eq(conversations.id, input.conversationId ?? ""),
                eq(conversations.orgId, input.orgId),
                eq(workspaces.id, input.workspaceId),
                eq(workspaces.orgId, input.orgId),
              ),
            )
            .limit(1),
        )
        if (!rows.length)
          throw new Error("Conversation workspace is no longer available")
      }
      const row = await getSandboxInstance(key, input.orgId)
      if (!row) return null
      assertOwnedRecord(key, row)
      return toTanstackRecord(row)
    },
    async upsert(record) {
      const conversationId = record.threadId.trim() || null
      const isBase = record.key.startsWith("base:")
      if (
        isBase !== (conversationId === null) ||
        (input.conversationId !== undefined &&
          conversationId !== null &&
          conversationId !== input.conversationId) ||
        (input.provider !== undefined && record.provider !== input.provider)
      ) {
        throw new SandboxInstanceOwnershipConflict(record.key)
      }
      const persisted: SandboxInstanceRecord = {
        id: record.key,
        kind: "chat",
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        conversationId,
        provider: record.provider,
        providerSandboxId: record.providerSandboxId,
        image: input.image ?? null,
        transitionKey: record.transitionKey,
        revision: input.revision,
        latestSnapshotId: record.latestSnapshotId ?? null,
        latestRunId: record.latestRunId ?? null,
        state: "live",
        lastHeartbeatAt: new Date(record.updatedAt),
      }
      await persistSandboxInstance(persisted, ownershipOf(persisted))
    },
    async delete(key) {
      const row = await getSandboxInstance(key, input.orgId)
      if (!row) return
      assertOwnedRecord(key, row)
      await deleteSandboxInstance(key, input.orgId, deleteOwnershipOf(row))
    },
  }
}
