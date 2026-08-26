import { and, asc, eq, or, sql } from "drizzle-orm"
import { getOrgDb, withOrgDbContext } from "../db/client.js"
import { workspaceSandboxInstances } from "../db/schema/workspaces.js"
import { isUniqueViolation, orgSql } from "./workspace-sql.js"

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
  latestSnapshotId?: string | null
  latestRunId?: string | null
  state: "live" | "destroy_failed"
  lastHeartbeatAt: Date
}

export type ClaimedSandboxInstance = {
  record: SandboxInstanceRecord
  inserted: boolean
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
    await db.transaction(async (tx) => {
      if (input.kind === "chat" && input.conversationId) {
        const [existing] = await tx
          .select()
          .from(workspaceSandboxInstances)
          .where(
            and(
              eq(workspaceSandboxInstances.orgId, orgId),
              eq(workspaceSandboxInstances.kind, "chat"),
              eq(
                workspaceSandboxInstances.conversationId,
                input.conversationId,
              ),
              or(
                eq(workspaceSandboxInstances.state, "live"),
                eq(workspaceSandboxInstances.state, "destroy_failed"),
              ),
            ),
          )
          .orderBy(
            sql`(${workspaceSandboxInstances.providerSandboxId} is not null) desc`,
            asc(workspaceSandboxInstances.createdAt),
            asc(workspaceSandboxInstances.id),
          )
          .limit(1)
        if (existing && existing.id !== input.id) {
          await tx
            .update(workspaceSandboxInstances)
            .set({
              kind: input.kind,
              conversationId: input.conversationId ?? null,
              desiredUrl: input.desiredUrl ?? null,
              desiredGeneration: input.desiredGeneration ?? null,
              desiredSha: input.desiredSha ?? null,
              provider: input.provider ?? null,
              providerSandboxId: input.providerSandboxId ?? null,
              latestSnapshotId: input.latestSnapshotId ?? null,
              latestRunId: input.latestRunId ?? null,
              state: input.state,
              lastHeartbeatAt: input.lastHeartbeatAt,
              updatedAt: now,
            })
            .where(eq(workspaceSandboxInstances.id, existing.id))
          return
        }
      }
      await tx
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
            latestSnapshotId: input.latestSnapshotId ?? null,
            latestRunId: input.latestRunId ?? null,
            state: input.state,
            lastHeartbeatAt: input.lastHeartbeatAt,
            updatedAt: now,
          },
        })
    })
  })
}

export async function claimSandboxInstance(
  input: SandboxInstanceRecord,
): Promise<ClaimedSandboxInstance> {
  const orgId = requireSandboxOrgId(input.orgId)
  return withSandboxInstanceDb(orgId, async () => {
    const db = getOrgDb()
    return db.transaction(async (tx) => {
      const identityFilter =
        input.kind === "chat" && input.conversationId
          ? eq(workspaceSandboxInstances.conversationId, input.conversationId)
          : eq(workspaceSandboxInstances.workspaceId, input.workspaceId)
      const [existing] = await tx
        .select()
        .from(workspaceSandboxInstances)
        .where(
          and(
            eq(workspaceSandboxInstances.kind, input.kind),
            or(
              eq(workspaceSandboxInstances.state, "live"),
              eq(workspaceSandboxInstances.state, "destroy_failed"),
            ),
            identityFilter,
          ),
        )
        .orderBy(
          sql`(${workspaceSandboxInstances.providerSandboxId} is not null) desc`,
          asc(workspaceSandboxInstances.createdAt),
          asc(workspaceSandboxInstances.id),
        )
        .limit(1)
      const now = new Date()
      const live = existing ? toSandboxInstanceRecord(existing) : null
      if (live && existing) {
        if (existing.state === "destroy_failed") {
          await tx
            .update(workspaceSandboxInstances)
            .set({
              state: "live",
              lastHeartbeatAt: input.lastHeartbeatAt,
              updatedAt: now,
            })
            .where(eq(workspaceSandboxInstances.id, existing.id))
          return {
            record: {
              ...live,
              state: "live",
              lastHeartbeatAt: input.lastHeartbeatAt,
            },
            inserted: false,
          }
        }
        return { record: live, inserted: false }
      }

      try {
        await tx
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
            state: "live",
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
              state: "live",
              lastHeartbeatAt: input.lastHeartbeatAt,
              updatedAt: now,
            },
          })
      } catch (error) {
        const identityConstraint =
          input.kind === "chat"
            ? "workspace_sandbox_instances_live_chat_conversation_uidx"
            : "workspace_sandbox_instances_live_job_workspace_uidx"
        if (!isUniqueViolation(error, identityConstraint)) throw error
        const [conflict] = await tx
          .select()
          .from(workspaceSandboxInstances)
          .where(
            and(
              eq(workspaceSandboxInstances.kind, input.kind),
              or(
                eq(workspaceSandboxInstances.state, "live"),
                eq(workspaceSandboxInstances.state, "destroy_failed"),
              ),
              identityFilter,
            ),
          )
          .orderBy(
            sql`(${workspaceSandboxInstances.providerSandboxId} is not null) desc`,
            asc(workspaceSandboxInstances.createdAt),
            asc(workspaceSandboxInstances.id),
          )
          .limit(1)
        if (!conflict) throw error
        const record = toSandboxInstanceRecord(conflict)
        if (!record) throw error
        return { record, inserted: false }
      }
      const [row] = await tx
        .select()
        .from(workspaceSandboxInstances)
        .where(eq(workspaceSandboxInstances.id, input.id))
        .limit(1)
      const record = row ? toSandboxInstanceRecord(row) : null
      return {
        record: record ?? { ...input, state: "live" },
        inserted: true,
      }
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
