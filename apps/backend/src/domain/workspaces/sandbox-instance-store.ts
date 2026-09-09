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
  deleteSandboxInstance,
  getSandboxInstance,
  persistSandboxInstance,
} from "../../models/workspaces.js"
import type { WorkspaceRevision } from "./revision.js"

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
}): SandboxInstanceStore {
  return {
    async findByTransitionKey(key) {
      const [row] = await withOrgDbContext(input.orgId, (db) =>
        db
          .select()
          .from(workspaceSandboxInstances)
          .where(
            and(
              eq(workspaceSandboxInstances.workspaceId, input.workspaceId),
              eq(workspaceSandboxInstances.transitionKey, key),
              eq(workspaceSandboxInstances.state, "live"),
            ),
          )
          .orderBy(desc(workspaceSandboxInstances.lastHeartbeatAt))
          .limit(1),
      )
      if (row) return toTanstackRecord({ ...row, kind: "chat", state: "live" })
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
              image: input.image ?? null,
              latestRunId: record.latestRunId ?? null,
              latestSnapshotId: record.latestSnapshotId ?? null,
              lastHeartbeatAt: new Date(record.updatedAt),
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(workspaceSandboxInstances.id, fromKey),
                eq(workspaceSandboxInstances.workspaceId, input.workspaceId),
                eq(workspaceSandboxInstances.conversationId, record.threadId),
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
                eq(workspaces.id, input.workspaceId),
              ),
            )
            .limit(1),
        )
        if (!rows.length)
          throw new Error("Conversation workspace is no longer available")
      }
      const row = await getSandboxInstance(key, input.orgId)
      return row ? toTanstackRecord(row) : null
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
        image: input.image ?? null,
        transitionKey: record.transitionKey,
        revision: input.revision,
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
