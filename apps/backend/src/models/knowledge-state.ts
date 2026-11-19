import { and, eq, sql } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"

/*
 * The state updates of a knowledge run (ADR-067 decisions 2, 4 and 8). The
 * hydrate lease lock lets one run of a Workspace run at a time, so these
 * updates need no compare-and-set.
 */

type KnowledgeStateKey = { orgId: string; workspaceId: string }

function stateRow({ orgId, workspaceId }: KnowledgeStateKey) {
  return and(
    eq(knowledgeState.organizationId, orgId),
    eq(knowledgeState.workspaceId, workspaceId),
  )
}

/** The state row of a Workspace, or null before its first run. */
export async function getKnowledgeState(key: KnowledgeStateKey) {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db.select().from(knowledgeState).where(stateRow(key)),
  )
  return row ?? null
}

/**
 * Add the tip to `attempt_shas` before the run writes a row. The list only
 * grows, so a crash at any point loses no SHA. A retry of the same tip adds
 * nothing. The Workspace must belong to the org: the foreign key does not
 * check the org, so without this check an org could take the row of a
 * Workspace of another org.
 */
export async function beginKnowledgeRun(
  input: KnowledgeStateKey & { tip: string },
): Promise<void> {
  await withOrgDbContext(input.orgId, async (db) => {
    const [workspace] = await db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(
        and(
          eq(workspaces.orgId, input.orgId),
          eq(workspaces.id, input.workspaceId),
        ),
      )
    if (!workspace)
      throw new Error(
        `The org ${input.orgId} has no Workspace ${input.workspaceId}`,
      )
    await db
      .insert(knowledgeState)
      .values({
        workspaceId: input.workspaceId,
        organizationId: input.orgId,
        attemptShas: [input.tip],
        runStatus: "running",
      })
      .onConflictDoUpdate({
        target: knowledgeState.workspaceId,
        set: {
          attemptShas: sql`case when ${input.tip} = any(${knowledgeState.attemptShas}) then ${knowledgeState.attemptShas} else array_append(${knowledgeState.attemptShas}, ${input.tip}::text) end`,
          runStatus: "running",
          updatedAt: new Date(),
        },
      })
  })
}

/**
 * Record a run that applied all of its work: `last_sha` moves to the tip,
 * and `attempt_shas` becomes empty, in one update.
 */
export async function completeKnowledgeRun(
  input: KnowledgeStateKey & {
    tip: string
    projectionVersion: string
    /** The count of `failed` documents (ADR-067 decisions 8 and 11). */
    failedCount: number
  },
): Promise<void> {
  await updateState(input, {
    lastSha: input.tip,
    attemptShas: [],
    projectionVersion: input.projectionVersion,
    runStatus: "completed",
    failedCount: input.failedCount,
  })
}

/**
 * Record a run that stopped on an infrastructure error. `last_sha` and
 * `attempt_shas` stay, so the next run applies the same files again.
 */
export async function failKnowledgeRun(key: KnowledgeStateKey): Promise<void> {
  await updateState(key, { runStatus: "failed" })
}

/** Update the row that `beginKnowledgeRun` made. Without that row, throw. */
async function updateState(
  key: KnowledgeStateKey,
  values: Partial<typeof knowledgeState.$inferInsert>,
): Promise<void> {
  const updated = await withOrgDbContext(key.orgId, (db) =>
    db
      .update(knowledgeState)
      .set({ ...values, updatedAt: new Date() })
      .where(stateRow(key))
      .returning({ workspaceId: knowledgeState.workspaceId }),
  )
  if (!updated.length)
    throw new Error(
      `The Workspace ${key.workspaceId} has no knowledge run; call beginKnowledgeRun first`,
    )
}
