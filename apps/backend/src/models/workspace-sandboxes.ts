import { and, eq } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { workspaceSandboxInstances } from "../db/schema/workspaces.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { orgSql } from "./workspace-sql.js"

export type SandboxInstanceRecord = {
  id: string
  kind: "chat" | "job"
  orgId: string
  workspaceId: string
  conversationId?: string | null
  desiredUrl?: string | null
  desiredGeneration?: number | null
  desiredSha?: string | null
  provider?: string | null
  providerSandboxId?: string | null
  revision?: WorkspaceRevision | null
  latestSnapshotId?: string | null
  latestRunId?: string | null
  state: "live" | "destroy_failed"
  lastHeartbeatAt: Date
}

function toSandboxInstanceRecord(
  row: typeof workspaceSandboxInstances.$inferSelect,
): SandboxInstanceRecord | null {
  if (row.kind !== "chat" && row.kind !== "job") return null
  if (row.state !== "live" && row.state !== "destroy_failed") return null
  return {
    id: row.id,
    kind: row.kind,
    orgId: row.orgId,
    workspaceId: row.workspaceId,
    conversationId: row.conversationId,
    desiredUrl: row.desiredUrl,
    desiredGeneration: row.desiredGeneration,
    desiredSha: row.desiredSha,
    provider: row.provider,
    providerSandboxId: row.providerSandboxId,
    revision: row.revision,
    latestSnapshotId: row.latestSnapshotId,
    latestRunId: row.latestRunId,
    state: row.state,
    lastHeartbeatAt: row.lastHeartbeatAt,
  }
}

function requireSandboxOrgId(orgId: string | null | undefined): string {
  if (!orgId) throw new Error("sandbox orgId is required")
  return orgId
}

async function withSandboxInstanceDb<T>(
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withOrgDbContext(orgId, fn)
}

export async function persistSandboxInstance(
  input: SandboxInstanceRecord,
): Promise<void> {
  const orgId = requireSandboxOrgId(input.orgId)
  const now = new Date()
  await withSandboxInstanceDb(orgId, async () => {
    const db = getOrgDb()
    await db
      .insert(workspaceSandboxInstances)
      .values({
        id: input.id,
        kind: input.kind,
        orgId,
        workspaceId: input.workspaceId,
        conversationId: input.conversationId ?? null,
        desiredUrl: input.desiredUrl ?? null,
        desiredGeneration: input.desiredGeneration ?? null,
        desiredSha: input.desiredSha ?? null,
        provider: input.provider ?? null,
        providerSandboxId: input.providerSandboxId ?? null,
        revision: input.revision ?? null,
        latestSnapshotId: input.latestSnapshotId ?? null,
        latestRunId: input.latestRunId ?? null,
        state: input.state,
        lastHeartbeatAt: input.lastHeartbeatAt,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: workspaceSandboxInstances.id,
        set: {
          kind: input.kind,
          conversationId: input.conversationId ?? null,
          desiredUrl: input.desiredUrl ?? null,
          desiredGeneration: input.desiredGeneration ?? null,
          desiredSha: input.desiredSha ?? null,
          provider: input.provider ?? null,
          providerSandboxId: input.providerSandboxId ?? null,
          revision: input.revision ?? null,
          latestSnapshotId: input.latestSnapshotId ?? null,
          latestRunId: input.latestRunId ?? null,
          state: input.state,
          lastHeartbeatAt: input.lastHeartbeatAt,
          updatedAt: now,
        },
      })
  })
}

export async function heartbeatSandboxInstance(
  id: string,
  at: Date,
  orgId?: string | null,
): Promise<void> {
  const scopedOrgId = requireSandboxOrgId(orgId)
  await withSandboxInstanceDb(scopedOrgId, async () => {
    await getOrgDb()
      .update(workspaceSandboxInstances)
      .set({ lastHeartbeatAt: at, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceSandboxInstances.id, id),
          eq(workspaceSandboxInstances.orgId, scopedOrgId),
        ),
      )
  })
}

export async function listSandboxInstances(input: {
  workspaceId?: string
  conversationId?: string
  kind?: "chat" | "job"
  state?: "live" | "destroy_failed"
}): Promise<SandboxInstanceRecord[]> {
  return orgSql(async () => {
    const db = getOrgDb()
    const filters = [
      input.workspaceId
        ? eq(workspaceSandboxInstances.workspaceId, input.workspaceId)
        : undefined,
      input.conversationId
        ? eq(workspaceSandboxInstances.conversationId, input.conversationId)
        : undefined,
      input.kind ? eq(workspaceSandboxInstances.kind, input.kind) : undefined,
      input.state
        ? eq(workspaceSandboxInstances.state, input.state)
        : undefined,
    ].filter((value): value is NonNullable<typeof value> => value != null)
    const rows = await db
      .select()
      .from(workspaceSandboxInstances)
      .where(filters.length > 0 ? and(...filters) : undefined)
    return rows.flatMap((row) => {
      const record = toSandboxInstanceRecord(row)
      return record ? [record] : []
    })
  })
}

export async function getSandboxInstance(
  id: string,
  orgId?: string | null,
): Promise<SandboxInstanceRecord | null> {
  const scopedOrgId = requireSandboxOrgId(orgId)
  return withSandboxInstanceDb(scopedOrgId, async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceSandboxInstances)
      .where(
        and(
          eq(workspaceSandboxInstances.id, id),
          eq(workspaceSandboxInstances.orgId, scopedOrgId),
        ),
      )
      .limit(1)
    return row ? toSandboxInstanceRecord(row) : null
  })
}

export async function deleteSandboxInstance(
  id: string,
  orgId?: string | null,
): Promise<void> {
  const scopedOrgId = requireSandboxOrgId(orgId)
  await withSandboxInstanceDb(scopedOrgId, async () => {
    await getOrgDb()
      .delete(workspaceSandboxInstances)
      .where(
        and(
          eq(workspaceSandboxInstances.id, id),
          eq(workspaceSandboxInstances.orgId, scopedOrgId),
        ),
      )
  })
}
