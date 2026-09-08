import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { type Db, withOrgDbContext } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { connections } from "../db/schema/connections.js"

export const connectorContentBindingSchema = z.object({
  provider: z.enum(["linear", "notion", "confluence"]),
  repositoryId: z.string().min(1),
  branch: z.string().min(1),
  workspaceId: z.string().nullable(),
  cloudId: z.string().nullable(),
  atlassianApiBaseUrl: z.string().nullable(),
})

type ContentBinding = z.infer<typeof connectorContentBindingSchema>

async function readBinding(
  db: Db,
  connection: typeof connections.$inferSelect,
) {
  const [target] =
    connection.type === "forge"
      ? await db
          .select()
          .from(confluenceSyncTargets)
          .where(eq(confluenceSyncTargets.connectionId, connection.id))
      : []
  const config = connection.config
  const binding = connectorContentBindingSchema.safeParse({
    provider: connection.type === "forge" ? "confluence" : connection.type,
    repositoryId: target?.repositoryId ?? config.repositoryId,
    branch: target?.branch ?? config.branch,
    workspaceId: connection.type === "forge" ? null : config.workspaceId,
    cloudId: connection.type === "forge" ? config.cloudId : null,
    atlassianApiBaseUrl:
      connection.type === "forge" ? (config.atlassianApiBaseUrl ?? null) : null,
  })
  if (!binding.success) return null
  return {
    binding: binding.data,
    enabled: target?.enabled ?? config.enabled === true,
    setupPhase: target?.setupPhase ?? config.setupPhase,
    pendingConfigPrCreating:
      target?.pendingConfigPrCreating ??
      config.pendingConfigPrCreating === true,
    installed: !["revoked", "uninstalled", "pending"].includes(
      String(config.status),
    ),
  }
}

function sameBinding(a: unknown, b: ContentBinding): boolean {
  const parsed = connectorContentBindingSchema.safeParse(a)
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(b)
}

/** Read intent only. Initial-sync state is published after native admission. */
export async function prepareConnectorContentSync(input: {
  orgId: string
  connectionId: string
  provider: ContentBinding["provider"]
  repositoryId?: string
  branch: string
  configKey?: string
}) {
  return withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
    if (!connection) return null
    const current = await readBinding(db, connection)
    if (
      !current?.enabled ||
      !current.installed ||
      current.binding.provider !== input.provider ||
      (input.repositoryId != null &&
        current.binding.repositoryId !== input.repositoryId) ||
      current.binding.branch !== input.branch ||
      !["awaiting_merge", "initial_sync", "sync_failed", "live"].includes(
        String(current.setupPhase),
      )
    )
      return null
    if (!input.configKey && current.setupPhase !== "sync_failed") return null
    if (input.configKey && connection.contentSyncWorkflowRunId) {
      const result = await db.execute<{
        id: string
        input: Record<string, unknown>
      }>(sql`
        select id, input from openworkflow.workflow_runs where id = ${connection.contentSyncWorkflowRunId}
          and input->>'orgId' = ${input.orgId} and input->>'connectionId' = ${input.connectionId}
      `)
      const owner = result.rows[0]
      if (
        owner?.input.configKey === input.configKey &&
        sameBinding(owner.input.contentSyncBinding, current.binding)
      )
        return {
          existingRunId: owner.id,
          contentSyncBinding: current.binding,
          contentSyncGeneration: connection.contentSyncGeneration,
        }
    }
    return {
      existingRunId: null,
      contentSyncBinding: current.binding,
      contentSyncGeneration: connection.contentSyncGeneration + 1,
    }
  })
}

/** Native owner first; the workflow repeats this step after an admission-process crash. */
export async function activateConnectorContentSync(input: {
  orgId: string
  connectionId: string
  workflowRunId: string
}): Promise<boolean> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for("update")
    if (!connection) return false
    const current = await readBinding(db, connection)
    if (!current?.enabled || !current.installed) return false
    const result = await db.execute<{
      status: string
      input: Record<string, unknown>
    }>(sql`
      select status, input from openworkflow.workflow_runs where id = ${input.workflowRunId}
        and workflow_name = ${`${current.binding.provider}-sync-content`}
        and input->>'orgId' = ${input.orgId} and input->>'connectionId' = ${input.connectionId}
    `)
    const owner = result.rows[0]
    if (!owner) return false
    const generation = owner.input.contentSyncGeneration ?? 0
    if (
      owner.input.contentSyncBinding &&
      !sameBinding(owner.input.contentSyncBinding, current.binding)
    )
      return false
    if (connection.contentSyncWorkflowRunId === input.workflowRunId)
      return generation === connection.contentSyncGeneration
    if (["failed", "canceled", "completed"].includes(owner.status)) return false
    // Existing persisted generation-zero runs retain their pre-upgrade activation.
    const legacy =
      !owner.input.contentSyncBinding &&
      generation === connection.contentSyncGeneration &&
      !connection.contentSyncWorkflowRunId &&
      (current.setupPhase === "initial_sync" ||
        (current.binding.provider === "confluence" &&
          current.setupPhase === "live"))
    if (!legacy && generation !== connection.contentSyncGeneration + 1)
      return false
    if (
      !legacy &&
      !["awaiting_merge", "initial_sync", "sync_failed", "live"].includes(
        String(current.setupPhase),
      )
    )
      return false
    if (typeof generation !== "number") return false
    await db
      .update(connections)
      .set({
        contentSyncGeneration: generation,
        contentSyncWorkflowRunId: input.workflowRunId,
        ...(current.binding.provider === "confluence"
          ? {}
          : {
              config: {
                ...connection.config,
                setupPhase: "initial_sync",
                pendingConfigPullUrl: null,
                pendingConfigPrCreating: false,
              },
            }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
    if (current.binding.provider === "confluence")
      await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase: "initial_sync",
          pendingConfigPullUrl: null,
          pendingConfigPrCreating: false,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
    return true
  })
}

export async function findConnectorContentSyncOwner(input: {
  orgId: string
  connectionId: string
  provider: ContentBinding["provider"]
  idempotencyKey: string
}): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ id: string }>(sql`
      select id from openworkflow.workflow_runs where workflow_name = ${`${input.provider}-sync-content`}
        and input->>'orgId' = ${input.orgId} and input->>'connectionId' = ${input.connectionId}
        and idempotency_key = ${input.idempotencyKey} order by created_at desc limit 1
    `)
    return result.rows[0]?.id ?? null
  })
}

/** Recheck after native activation replay and before capturing any external content. */
export async function assertConnectorContentSyncBinding(input: {
  orgId: string
  connectionId: string
  contentSyncGeneration?: number
  contentSyncBinding?: ContentBinding
}): Promise<void> {
  const valid = await withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
    if (
      !connection ||
      connection.contentSyncGeneration !== (input.contentSyncGeneration ?? 0)
    )
      return false
    const current = await readBinding(db, connection)
    return Boolean(
      current?.enabled &&
        current.installed &&
        (!input.contentSyncBinding ||
          sameBinding(input.contentSyncBinding, current.binding)),
    )
  })
  if (!valid) throw new Error("Connector content activation was superseded")
}

/** Persist this non-secret binding as the config workflow's first native step. */
export async function captureConnectorConfigSyncBinding(input: {
  orgId: string
  connectionId: string
  contentSyncGeneration: number
}) {
  return withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
    if (
      !connection ||
      connection.contentSyncGeneration !== input.contentSyncGeneration
    )
      return null
    const current = await readBinding(db, connection)
    if (
      !current?.enabled ||
      !current.installed ||
      current.setupPhase !== "awaiting_merge" ||
      !current.pendingConfigPrCreating
    )
      return null
    return current.binding
  })
}

export async function getConnectorContentSyncGeneration(
  orgId: string,
  connectionId: string,
): Promise<number> {
  return withOrgDbContext(orgId, async (db) => {
    const [row] = await db
      .select({ generation: connections.contentSyncGeneration })
      .from(connections)
      .where(eq(connections.id, connectionId))
    if (!row) throw new Error("Connector connection is missing")
    return row.generation
  })
}

/** Project only the current native owner's terminal state; this never schedules or retries work. */
export async function reconcileConnectorContentSync(input: {
  orgId: string
  connectionId: string
  admissionFailedGeneration?: number
}): Promise<boolean> {
  return withOrgDbContext(input.orgId, async (db) => {
    const [connection] = await db
      .select()
      .from(connections)
      .where(eq(connections.id, input.connectionId))
      .for("update")
    if (!connection) return false
    if (
      input.admissionFailedGeneration != null &&
      input.admissionFailedGeneration !== connection.contentSyncGeneration
    )
      return false
    const provider =
      connection.type === "forge" ? "confluence" : connection.type
    if (!["linear", "notion", "confluence"].includes(provider)) return false
    const current = await readBinding(db, connection)
    if (
      current?.setupPhase === "awaiting_merge" &&
      current.pendingConfigPrCreating
    ) {
      const result = await db.execute<{ status: string; binding: unknown }>(sql`
        select owner.status, attempt.output as binding from openworkflow.workflow_runs owner
        join openworkflow.step_attempts attempt on attempt.namespace_id = owner.namespace_id and attempt.workflow_run_id = owner.id
        where owner.workflow_name = ${`${provider}-sync-config`}
          and owner.input->>'orgId' = ${input.orgId} and owner.input->>'connectionId' = ${input.connectionId}
          and coalesce(owner.input->>'contentSyncGeneration','0') = ${String(connection.contentSyncGeneration)}
          and attempt.step_name = 'capture-config-binding' and attempt.status = 'completed'
        order by owner.created_at desc, attempt.created_at desc limit 1
      `)
      const configOwner = result.rows[0]
      if (
        configOwner &&
        ["failed", "canceled"].includes(configOwner.status) &&
        sameBinding(configOwner.binding, current.binding)
      ) {
        if (provider === "confluence")
          await db
            .update(confluenceSyncTargets)
            .set({
              setupPhase: "config_failed",
              pendingConfigPrCreating: false,
              updatedAt: new Date(),
            })
            .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
        else
          await db
            .update(connections)
            .set({
              config: {
                ...connection.config,
                setupPhase: "config_failed",
                pendingConfigPrCreating: false,
              },
              updatedAt: new Date(),
            })
            .where(eq(connections.id, input.connectionId))
      }
      return Boolean(configOwner)
    }
    const result = await db.execute<{
      status: string
      input: Record<string, unknown>
    }>(sql`
      select status, input from openworkflow.workflow_runs
      where workflow_name = ${`${provider}-sync-content`}
        and input->>'orgId' = ${input.orgId}
        and input->>'connectionId' = ${input.connectionId}
        and coalesce(input->>'contentSyncGeneration', '0') = ${String(connection.contentSyncGeneration)}
        and (${connection.contentSyncWorkflowRunId}::text is null or id = ${connection.contentSyncWorkflowRunId})
      order by created_at desc limit 1
    `)
    const owner = result.rows[0]
    if (
      owner?.input.contentSyncBinding &&
      (!current ||
        !sameBinding(owner.input.contentSyncBinding, current.binding))
    )
      return false
    if (
      !(owner && ["failed", "canceled"].includes(owner.status)) &&
      !(input.admissionFailedGeneration != null && !owner)
    )
      return Boolean(owner)
    if (provider === "confluence") {
      await db
        .update(confluenceSyncTargets)
        .set({ setupPhase: "sync_failed", updatedAt: new Date() })
        .where(
          and(
            eq(confluenceSyncTargets.connectionId, input.connectionId),
            eq(confluenceSyncTargets.setupPhase, "initial_sync"),
          ),
        )
    } else if (connection.config.setupPhase === "initial_sync") {
      await db
        .update(connections)
        .set({
          config: { ...connection.config, setupPhase: "sync_failed" },
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
    }
    return Boolean(owner)
  })
}
