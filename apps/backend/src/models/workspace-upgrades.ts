import { and, asc, eq, inArray, like, ne, or, sql } from "drizzle-orm"
import { requireCurrentOrgId } from "../auth/context.js"
import { getOrgDb } from "../db/client.js"
import { workspaceWriteJobs } from "../db/schema/workspaces.js"
import {
  UPGRADE_JOB_KIND,
  type UpgradeStatus,
  upgradeJobId,
  type WorkspaceUpgradePayload,
} from "../domain/upgrades/registry.js"
import { orgSql } from "./workspace-sql.js"

/** One upgrade row of a Workspace, as the API and the workflows read it. */
export type WorkspaceUpgradeRow = {
  id: string
  workspaceId: string
  generation: number
  status: UpgradeStatus
  desiredSha: string | null
  upgrade: WorkspaceUpgradePayload
  workflowRunId: string | null
  failureReason: string | null
  updatedAt: Date
}

function toUpgradeRow(
  row: typeof workspaceWriteJobs.$inferSelect,
): WorkspaceUpgradeRow | null {
  const upgrade = row.payload?.upgrade
  if (row.kind !== UPGRADE_JOB_KIND || !upgrade) return null
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    generation: row.generation,
    status: row.status as UpgradeStatus,
    desiredSha: row.desiredSha,
    upgrade,
    workflowRunId: row.payload?.workflowRunId ?? null,
    failureReason: row.payload?.failureReason ?? null,
    updatedAt: row.updatedAt,
  }
}

/** The upgrade rows of a Workspace, oldest first. */
export async function listWorkspaceUpgradeRows(
  workspaceId: string,
): Promise<WorkspaceUpgradeRow[]> {
  return orgSql(async () => {
    const rows = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, workspaceId),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
        ),
      )
      .orderBy(asc(workspaceWriteJobs.createdAt), asc(workspaceWriteJobs.id))
    return rows.flatMap((row) => toUpgradeRow(row) ?? [])
  })
}

export async function getWorkspaceUpgradeRow(
  workspaceId: string,
  key: string,
): Promise<WorkspaceUpgradeRow | null> {
  return orgSql(async () => {
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.id, upgradeJobId(workspaceId, key)),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
        ),
      )
      .limit(1)
    return row ? toUpgradeRow(row) : null
  })
}

/** Insert the row when it does not exist. A second insert does nothing. */
export async function insertWorkspaceUpgradeRow(input: {
  workspaceId: string
  generation: number
  status: UpgradeStatus
  upgrade: WorkspaceUpgradePayload
}): Promise<void> {
  await orgSql(async () => {
    await getOrgDb()
      .insert(workspaceWriteJobs)
      .values({
        id: upgradeJobId(input.workspaceId, input.upgrade.key),
        orgId: requireCurrentOrgId(),
        workspaceId: input.workspaceId,
        kind: UPGRADE_JOB_KIND,
        generation: input.generation,
        desiredSha: null,
        status: input.status,
        payload: { upgrade: input.upgrade },
      })
      .onConflictDoNothing()
  })
}

/**
 * Change the row only while its status is one of `from` (compare and set).
 * `upgrade` keys with the value `undefined` are removed. Returns the changed
 * row, or null when the row was not in a `from` status.
 */
export async function transitionWorkspaceUpgradeRow(input: {
  workspaceId: string
  key: string
  from: readonly UpgradeStatus[]
  to: UpgradeStatus
  upgrade?: Partial<WorkspaceUpgradePayload>
  generation?: number
  desiredSha?: string | null
  workflowRunId?: string | null
  failureReason?: string | null
  /** Only change a row that this workflow run owns. */
  ownerRunId?: string
}): Promise<WorkspaceUpgradeRow | null> {
  return orgSql(async () => {
    const id = upgradeJobId(input.workspaceId, input.key)
    const [row] = await getOrgDb()
      .select()
      .from(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.id, id),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
          inArray(workspaceWriteJobs.status, [...input.from]),
        ),
      )
      .for("update")
    const current = row ? toUpgradeRow(row) : null
    if (!row || !current) return null
    if (
      input.ownerRunId !== undefined &&
      current.workflowRunId !== input.ownerRunId
    )
      return null
    const upgrade = { ...current.upgrade, ...input.upgrade }
    for (const [key, value] of Object.entries(upgrade))
      if (value === undefined) delete upgrade[key as keyof typeof upgrade]
    const payload: NonNullable<typeof row.payload> = {
      ...row.payload,
      upgrade,
    }
    if (input.workflowRunId !== undefined) {
      if (input.workflowRunId === null) delete payload.workflowRunId
      else payload.workflowRunId = input.workflowRunId
    }
    if (input.failureReason !== undefined) {
      if (input.failureReason === null) delete payload.failureReason
      else payload.failureReason = input.failureReason
    }
    const [updated] = await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        status: input.to,
        payload,
        ...(input.generation !== undefined
          ? { generation: input.generation }
          : {}),
        ...(input.desiredSha !== undefined
          ? { desiredSha: input.desiredSha }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(workspaceWriteJobs.id, id))
      .returning()
    return updated ? toUpgradeRow(updated) : null
  })
}

/**
 * Remove the rows of other upgrade keys of the same family (`format-` or
 * `reingest-`, the prefix of `key`) that wait for a click or cannot start:
 * a newer release replaced them. A row with an open pull request or a run
 * stays.
 */
export async function deleteSupersededUpgradeRows(input: {
  workspaceId: string
  key: string
  statuses: readonly UpgradeStatus[]
}): Promise<void> {
  const family = `${upgradeJobId(input.workspaceId, input.key.split("-")[0] ?? input.key)}-`
  await orgSql(async () => {
    await getOrgDb()
      .delete(workspaceWriteJobs)
      .where(
        and(
          eq(workspaceWriteJobs.workspaceId, input.workspaceId),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
          ne(workspaceWriteJobs.id, upgradeJobId(input.workspaceId, input.key)),
          like(workspaceWriteJobs.id, `${family.replace(/[\\%_]/g, "\\$&")}%`),
          inArray(workspaceWriteJobs.status, [...input.statuses]),
        ),
      )
  })
}

/**
 * A run can stop before it records its result (for example a worker that
 * dies after its last retry). Set such a row to `failed`, so that an owner or
 * admin can start it again. OpenWorkflow owns the retries, so only a run
 * that ended counts:
 * - a `running` row whose recorded run ended;
 * - a `queued` row whose run ended before it claimed the row. That run has
 *   the idempotency key `<row id>:<approvedAt>` of this click
 *   (see `enqueueWorkspaceUpgrade` and `enqueueWorkspaceUpgradeReingest`). An older run of the same row does not
 *   count, and a row whose run is not queued yet stays `queued`.
 *
 * Without `key`, this checks all the upgrade rows of the Workspace.
 */
export async function failStoppedUpgradeRun(
  workspaceId: string,
  key?: string,
): Promise<void> {
  const ended = sql`('completed', 'failed', 'canceled')`
  const upgradeWorkflows = sql`('workspace-upgrade', 'workspace-upgrade-reingest')`
  await orgSql(async () => {
    await getOrgDb()
      .update(workspaceWriteJobs)
      .set({
        status: "failed",
        payload: sql`jsonb_set(${workspaceWriteJobs.payload}, '{failureReason}', to_jsonb('The upgrade run stopped before it finished.'::text))`,
        updatedAt: new Date(),
      })
      .where(
        and(
          key === undefined
            ? eq(workspaceWriteJobs.workspaceId, workspaceId)
            : eq(workspaceWriteJobs.id, upgradeJobId(workspaceId, key)),
          eq(workspaceWriteJobs.kind, UPGRADE_JOB_KIND),
          or(
            and(
              eq(workspaceWriteJobs.status, "running"),
              sql`exists (select 1 from openworkflow.workflow_runs owner
                where owner.id = ${workspaceWriteJobs.payload}->>'workflowRunId'
                  and owner.workflow_name in ${upgradeWorkflows}
                  and owner.status in ${ended})`,
            ),
            and(
              eq(workspaceWriteJobs.status, "queued"),
              sql`exists (select 1 from openworkflow.workflow_runs owner
                where owner.idempotency_key = ${workspaceWriteJobs.id} || ':' || (${workspaceWriteJobs.payload}->'upgrade'->>'approvedAt')
                  and owner.workflow_name in ${upgradeWorkflows}
                  and owner.status in ${ended})`,
            ),
          ),
        ),
      )
  })
}
