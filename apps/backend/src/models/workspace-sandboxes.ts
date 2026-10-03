import { and, count, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm"
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
  image?: string | null
  revision?: WorkspaceRevision | null
  latestSnapshotId?: string | null
  latestRunId?: string | null
  /** `stopped`: the provider sandbox is stopped with its files kept; the next turn resumes it. */
  state: SandboxInstanceState
  lastHeartbeatAt: Date
}

export type SandboxInstanceState = "live" | "stopped" | "destroy_failed"

export type SandboxInstanceOwnership = Pick<
  SandboxInstanceRecord,
  "kind" | "workspaceId" | "conversationId" | "provider" | "image" | "revision"
>

export type SandboxInstanceDeleteOwnership = SandboxInstanceOwnership &
  Pick<SandboxInstanceRecord, "providerSandboxId">

export class SandboxInstanceOwnershipConflict extends Error {
  constructor(readonly sandboxKey: string) {
    super(
      `Sandbox instance ${sandboxKey} is already owned by another workspace identity`,
    )
    this.name = "SandboxInstanceOwnershipConflict"
  }
}

function toSandboxInstanceRecord(
  row: typeof workspaceSandboxInstances.$inferSelect,
): SandboxInstanceRecord | null {
  if (row.kind !== "chat" && row.kind !== "job") return null
  if (
    row.state !== "live" &&
    row.state !== "stopped" &&
    row.state !== "destroy_failed"
  )
    return null
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
    image: row.image,
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
  expected?: SandboxInstanceOwnership,
): Promise<void> {
  const orgId = requireSandboxOrgId(input.orgId)
  const now = new Date()
  await withSandboxInstanceDb(orgId, async () => {
    const db = getOrgDb()
    const persisted = await db
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
        image: input.image ?? null,
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
        setWhere: expected
          ? and(
              eq(workspaceSandboxInstances.orgId, orgId),
              eq(workspaceSandboxInstances.workspaceId, expected.workspaceId),
              eq(workspaceSandboxInstances.kind, expected.kind),
              expected.conversationId == null
                ? isNull(workspaceSandboxInstances.conversationId)
                : eq(
                    workspaceSandboxInstances.conversationId,
                    expected.conversationId,
                  ),
              expected.provider == null
                ? isNull(workspaceSandboxInstances.provider)
                : eq(workspaceSandboxInstances.provider, expected.provider),
              expected.image == null
                ? isNull(workspaceSandboxInstances.image)
                : eq(workspaceSandboxInstances.image, expected.image),
              expected.revision == null
                ? isNull(workspaceSandboxInstances.revision)
                : eq(workspaceSandboxInstances.revision, expected.revision),
            )
          : undefined,
        set: {
          kind: input.kind,
          conversationId: input.conversationId ?? null,
          desiredUrl: input.desiredUrl ?? null,
          desiredGeneration: input.desiredGeneration ?? null,
          desiredSha: input.desiredSha ?? null,
          provider: input.provider ?? null,
          providerSandboxId: input.providerSandboxId ?? null,
          image: input.image ?? null,
          revision: input.revision ?? null,
          latestSnapshotId: input.latestSnapshotId ?? null,
          latestRunId: input.latestRunId ?? null,
          state: input.state,
          lastHeartbeatAt: input.lastHeartbeatAt,
          updatedAt: now,
        },
      })
      .returning({ id: workspaceSandboxInstances.id })
    if (expected && persisted.length !== 1)
      throw new SandboxInstanceOwnershipConflict(input.id)
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
  state?: SandboxInstanceState
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

/**
 * Conversation sandboxes the org is running now: live Docker or Vercel rows,
 * including slots reserved for a create in progress. `excludingId` leaves out
 * the sandbox about to start, so starting it again never counts twice.
 */
export async function countRunningConversationSandboxes(
  orgId: string,
  excludingId: string,
): Promise<number> {
  return withSandboxInstanceDb(orgId, async () => {
    const [row] = await getOrgDb()
      .select({ running: count() })
      .from(workspaceSandboxInstances)
      .where(
        and(
          eq(workspaceSandboxInstances.orgId, orgId),
          eq(workspaceSandboxInstances.kind, "chat"),
          eq(workspaceSandboxInstances.state, "live"),
          isNotNull(workspaceSandboxInstances.conversationId),
          inArray(workspaceSandboxInstances.provider, ["docker", "vercel"]),
          ne(workspaceSandboxInstances.id, excludingId),
        ),
      )
    return row?.running ?? 0
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
  expected?: SandboxInstanceDeleteOwnership,
): Promise<void> {
  const scopedOrgId = requireSandboxOrgId(orgId)
  await withSandboxInstanceDb(scopedOrgId, async () => {
    const db = getOrgDb()
    const deleted = await db
      .delete(workspaceSandboxInstances)
      .where(
        and(
          eq(workspaceSandboxInstances.id, id),
          eq(workspaceSandboxInstances.orgId, scopedOrgId),
          expected
            ? eq(workspaceSandboxInstances.workspaceId, expected.workspaceId)
            : undefined,
          expected
            ? eq(workspaceSandboxInstances.kind, expected.kind)
            : undefined,
          expected
            ? expected.conversationId == null
              ? isNull(workspaceSandboxInstances.conversationId)
              : eq(
                  workspaceSandboxInstances.conversationId,
                  expected.conversationId,
                )
            : undefined,
          expected
            ? expected.provider == null
              ? isNull(workspaceSandboxInstances.provider)
              : eq(workspaceSandboxInstances.provider, expected.provider)
            : undefined,
          expected
            ? expected.providerSandboxId == null
              ? isNull(workspaceSandboxInstances.providerSandboxId)
              : eq(
                  workspaceSandboxInstances.providerSandboxId,
                  expected.providerSandboxId,
                )
            : undefined,
          expected
            ? expected.image == null
              ? isNull(workspaceSandboxInstances.image)
              : eq(workspaceSandboxInstances.image, expected.image)
            : undefined,
          expected
            ? expected.revision == null
              ? isNull(workspaceSandboxInstances.revision)
              : eq(workspaceSandboxInstances.revision, expected.revision)
            : undefined,
        ),
      )
      .returning({ id: workspaceSandboxInstances.id })
    if (!expected || deleted.length === 1) return
    const [collision] = await db
      .select({ id: workspaceSandboxInstances.id })
      .from(workspaceSandboxInstances)
      .where(
        and(
          eq(workspaceSandboxInstances.id, id),
          eq(workspaceSandboxInstances.orgId, scopedOrgId),
        ),
      )
      .limit(1)
    if (collision) throw new SandboxInstanceOwnershipConflict(id)
  })
}

/** Record that a conversation sandbox moved to a new commit, if it was still on `from`. */
export async function advanceSandboxInstanceRevision(input: {
  id: string
  orgId: string
  from: WorkspaceRevision
  to: WorkspaceRevision
}): Promise<void> {
  await withSandboxInstanceDb(input.orgId, async () => {
    const moved = await getOrgDb()
      .update(workspaceSandboxInstances)
      .set({ revision: input.to, updatedAt: new Date() })
      .where(
        and(
          eq(workspaceSandboxInstances.id, input.id),
          eq(workspaceSandboxInstances.orgId, input.orgId),
          eq(workspaceSandboxInstances.revision, input.from),
        ),
      )
      .returning({ id: workspaceSandboxInstances.id })
    if (moved.length !== 1) throw new SandboxInstanceOwnershipConflict(input.id)
  })
}
