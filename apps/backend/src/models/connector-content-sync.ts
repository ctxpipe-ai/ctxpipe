import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { type Db, withOrgDbContext } from "../db/client.js"
import { confluenceSyncTargets } from "../db/schema/confluenceSyncTargets.js"
import { connections } from "../db/schema/connections.js"
import {
  type LinearSetupPhase,
  parseForgeConnectionConfig,
  parseLinearConnectionStored,
  parseNotionConnectionConfig,
  serialiseLinearConnectionConfigForDb,
  serialiseNotionConnectionConfigForDb,
} from "../lib/connection-config.js"

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
  if (!["linear", "notion", "forge"].includes(connection.type)) return null
  const config =
    connection.type === "linear"
      ? parseLinearConnectionStored(connection.config)
      : connection.type === "notion"
        ? parseNotionConnectionConfig(connection.config)
        : {
            ...parseForgeConnectionConfig(connection.config),
            repositoryId: null,
            branch: null,
            workspaceId: null,
            enabled: false,
            setupPhase: "draft",
            pendingConfigPrCreating: false,
          }

  const binding = connectorContentBindingSchema.safeParse({
    provider: connection.type === "forge" ? "confluence" : connection.type,
    repositoryId: target?.repositoryId ?? config.repositoryId,
    branch: target?.branch ?? config.branch,
    workspaceId: connection.type === "forge" ? null : config.workspaceId,
    cloudId: "cloudId" in config ? config.cloudId : null,
    atlassianApiBaseUrl:
      "atlassianApiBaseUrl" in config
        ? (config.atlassianApiBaseUrl ?? null)
        : null,
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

function configWithLifecycle(
  connection: typeof connections.$inferSelect,
  update: {
    setupPhase: LinearSetupPhase
    pendingConfigPrCreating?: boolean
    pendingConfigPullUrl?: string | null
  },
) {
  if (connection.type === "linear")
    return serialiseLinearConnectionConfigForDb({
      ...parseLinearConnectionStored(connection.config),
      ...update,
    })
  if (connection.type === "notion")
    return serialiseNotionConnectionConfigForDb({
      ...parseNotionConnectionConfig(connection.config),
      ...update,
    })
  throw new Error("Connector lifecycle is not stored in this provider config")
}

function sameBinding(a: unknown, b: ContentBinding): boolean {
  const parsed = connectorContentBindingSchema.safeParse(a)
  return parsed.success && JSON.stringify(parsed.data) === JSON.stringify(b)
}

/** Read intent only. Initial-sync state is published after native admission. */
export async function prepareConnectorSync(input: {
  purpose: "config" | "content"
  legacyConfigRecovery?: boolean
  orgId: string
  connectionId: string
  provider: ContentBinding["provider"]
  repositoryId?: string
  branch?: string
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
      (input.branch != null && current.binding.branch !== input.branch) ||
      !(
        input.purpose === "config"
          ? [
              "draft",
              "config_failed",
              "awaiting_merge",
              "initial_sync",
              "live",
              "sync_failed",
            ]
          : ["awaiting_merge", "initial_sync", "sync_failed", "live"]
      ).includes(String(current.setupPhase))
    )
      return null
    if (
      input.legacyConfigRecovery &&
      (connection.contentSyncGeneration !== 0 ||
        connection.contentSyncWorkflowRunId != null ||
        current.pendingConfigPrCreating ||
        !(
          current.setupPhase === "initial_sync" ||
          (input.provider === "confluence" && current.setupPhase === "live")
        ))
    )
      return null
    if (
      input.purpose === "content" &&
      !input.configKey &&
      current.setupPhase !== "sync_failed"
    )
      return null
    if (input.configKey && connection.contentSyncWorkflowRunId) {
      const result = await db.execute<{
        id: string
        status: string
        input: Record<string, unknown>
      }>(sql`
        select id, status, input from openworkflow.workflow_runs where id = ${connection.contentSyncWorkflowRunId}
          and namespace_id = 'default' and version is null
          and workflow_name = ${`${input.provider}-sync-${input.purpose}`}
          and input->>'orgId' = ${input.orgId} and input->>'connectionId' = ${input.connectionId}
      `)
      const owner = result.rows[0]
      if (
        owner?.input.configKey === input.configKey &&
        !(
          input.purpose === "config" &&
          ["failed", "canceled"].includes(owner.status)
        ) &&
        sameBinding(owner.input.contentSyncBinding, current.binding)
      )
        return {
          existingRunId: owner.id,
          contentSyncBinding: current.binding,
          contentSyncGeneration: connection.contentSyncGeneration,
        }
    }
    if (
      input.purpose === "config" &&
      current.setupPhase === "awaiting_merge" &&
      current.pendingConfigPrCreating
    )
      return null
    return {
      existingRunId: null,
      contentSyncBinding: current.binding,
      contentSyncGeneration: connection.contentSyncGeneration + 1,
    }
  })
}

/** Native owner first; the workflow repeats this step after an admission-process crash. */
export async function activateConnectorSync(input: {
  purpose: "config" | "content"
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
        and namespace_id = 'default' and version is null
        and workflow_name = ${`${current.binding.provider}-sync-${input.purpose}`}
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
    // The API can observe the owner only after its child has advanced setup.
    // A completed proposal is already accepted; do not rewind that newer state.
    if (owner.status === "completed")
      return (
        input.purpose === "config" &&
        Boolean(owner.input.contentSyncBinding) &&
        typeof generation === "number" &&
        generation <= connection.contentSyncGeneration
      )
    const terminal = ["failed", "canceled"].includes(owner.status)
    const setupPhase = terminal
      ? input.purpose === "config"
        ? "config_failed"
        : "sync_failed"
      : input.purpose === "config"
        ? "awaiting_merge"
        : "initial_sync"
    // Existing persisted generation-zero runs retain their pre-upgrade activation.
    let legacy =
      !owner.input.contentSyncBinding &&
      generation === connection.contentSyncGeneration &&
      (input.purpose === "content"
        ? !connection.contentSyncWorkflowRunId &&
          (current.setupPhase === "initial_sync" ||
            (current.binding.provider === "confluence" &&
              current.setupPhase === "live"))
        : current.setupPhase === "awaiting_merge" &&
          current.pendingConfigPrCreating)
    if (
      legacy &&
      input.purpose === "config" &&
      connection.contentSyncWorkflowRunId
    ) {
      const previous = await db.execute<{ generation: string }>(
        sql`select coalesce(input->>'contentSyncGeneration','0') as generation from openworkflow.workflow_runs where id = ${connection.contentSyncWorkflowRunId} and namespace_id = 'default' and version is null and workflow_name in (${`${current.binding.provider}-sync-config`}, ${`${current.binding.provider}-sync-content`}) and input->>'orgId' = ${input.orgId} and input->>'connectionId' = ${input.connectionId}`,
      )
      legacy =
        Number(previous.rows[0]?.generation ?? -1) <
        connection.contentSyncGeneration
    }
    if (!legacy && generation !== connection.contentSyncGeneration + 1)
      return false
    if (
      !legacy &&
      input.purpose === "config" &&
      current.setupPhase === "awaiting_merge" &&
      current.pendingConfigPrCreating
    )
      return false
    if (
      !legacy &&
      !(
        input.purpose === "config"
          ? [
              "draft",
              "config_failed",
              "awaiting_merge",
              "initial_sync",
              "live",
              "sync_failed",
            ]
          : ["awaiting_merge", "initial_sync", "sync_failed", "live"]
      ).includes(String(current.setupPhase))
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
              config: configWithLifecycle(connection, {
                setupPhase,
                ...(input.purpose === "content"
                  ? { pendingConfigPullUrl: null }
                  : {}),
                pendingConfigPrCreating:
                  input.purpose === "config" && !terminal,
              }),
            }),
        updatedAt: new Date(),
      })
      .where(eq(connections.id, input.connectionId))
    if (current.binding.provider === "confluence")
      await db
        .update(confluenceSyncTargets)
        .set({
          setupPhase,
          ...(input.purpose === "content"
            ? { pendingConfigPullUrl: null }
            : {}),
          pendingConfigPrCreating: input.purpose === "config" && !terminal,
          updatedAt: new Date(),
        })
        .where(eq(confluenceSyncTargets.connectionId, input.connectionId))
    return true
  })
}

export async function findConnectorSyncOwner(input: {
  purpose: "config" | "content"
  orgId: string
  connectionId: string
  provider: ContentBinding["provider"]
  idempotencyKey: string
}): Promise<string | null> {
  return withOrgDbContext(input.orgId, async (db) => {
    const result = await db.execute<{ id: string }>(sql`
      select id from openworkflow.workflow_runs where namespace_id = 'default' and version is null and workflow_name = ${`${input.provider}-sync-${input.purpose}`}
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
  contentSyncBinding?: ContentBinding
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
      !current.pendingConfigPrCreating ||
      (input.contentSyncBinding &&
        !sameBinding(input.contentSyncBinding, current.binding))
    )
      return null
    return current.binding
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
        select owner.status, coalesce(owner.input->'contentSyncBinding', attempt.output) as binding
        from openworkflow.workflow_runs owner
        left join lateral (
          select output from openworkflow.step_attempts
          where namespace_id = owner.namespace_id and workflow_run_id = owner.id
            and step_name = 'capture-config-binding' and status = 'completed'
          order by created_at desc limit 1
        ) attempt on true
        where owner.namespace_id = 'default' and owner.version is null
          and owner.workflow_name = ${`${provider}-sync-config`}
          and owner.input->>'orgId' = ${input.orgId} and owner.input->>'connectionId' = ${input.connectionId}
          and coalesce(owner.input->>'contentSyncGeneration','0') = ${String(connection.contentSyncGeneration)}
          and (owner.id = ${connection.contentSyncWorkflowRunId} or not (owner.input ? 'contentSyncBinding'))
        order by owner.created_at desc limit 1
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
              config: configWithLifecycle(connection, {
                setupPhase: "config_failed",
                pendingConfigPrCreating: false,
              }),
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
      where namespace_id = 'default' and version is null and workflow_name = ${`${provider}-sync-content`}
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
    } else if (current?.setupPhase === "initial_sync") {
      await db
        .update(connections)
        .set({
          config: configWithLifecycle(connection, {
            setupPhase: "sync_failed",
          }),
          updatedAt: new Date(),
        })
        .where(eq(connections.id, input.connectionId))
    }
    return Boolean(owner)
  })
}
