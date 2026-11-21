import { and, eq, inArray } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"

/*
 * The state updates of a knowledge run (ADR-067 decisions 2 and 8, ADR-071
 * decision 4). The knowledge projection lease lets one run of a Workspace
 * run at a time, so these updates need no compare-and-set.
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

/** The head of the knowledge projection of a Workspace (ADR-071 decision 4). */
export type KnowledgeHead = {
  /** The tip that the last completed run applied (`last_sha`). */
  sha: string
  branch: string
  treeVersion: number
}

/**
 * The head of each Workspace whose knowledge projection is ready: a run
 * applied a tip in full. A later run that is `running` or `failed` does not
 * change this: a read sees only the tree rows at or below the head. A
 * Workspace before its first full run is not in the map.
 */
export async function readyKnowledgeHeads(
  orgId: string,
  workspaceIds: readonly string[],
): Promise<Map<string, KnowledgeHead>> {
  if (workspaceIds.length === 0) return new Map()
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select({
        workspaceId: knowledgeState.workspaceId,
        lastSha: knowledgeState.lastSha,
        branch: knowledgeState.branch,
        treeVersion: knowledgeState.treeVersion,
      })
      .from(knowledgeState)
      .where(
        and(
          eq(knowledgeState.organizationId, orgId),
          inArray(knowledgeState.workspaceId, [...workspaceIds]),
        ),
      ),
  )
  return new Map(
    rows.flatMap(({ workspaceId, lastSha, branch, treeVersion }) =>
      lastSha && branch && treeVersion !== null
        ? [[workspaceId, { sha: lastSha, branch, treeVersion }] as const]
        : [],
    ),
  )
}

/**
 * Mark the run of a Workspace as `running` before it writes a row. The
 * Workspace must belong to the org: the foreign key does not check the org,
 * so without this check an org could take the row of a Workspace of another
 * org.
 */
export async function beginKnowledgeRun(
  input: KnowledgeStateKey,
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
        runStatus: "running",
      })
      .onConflictDoUpdate({
        target: knowledgeState.workspaceId,
        set: { runStatus: "running", updatedAt: new Date() },
      })
  })
}

/**
 * Record a run that applied all of its work: the head moves to the tip and
 * to the tree version of the run, in one update. Until then, no read sees
 * the tree rows of the run.
 */
export async function completeKnowledgeRun(
  input: KnowledgeStateKey &
    Omit<KnowledgeHead, "sha"> & {
      tip: string
      projectionVersion: string
      /** The count of `failed` documents (ADR-067 decisions 8 and 11). */
      failedCount: number
    },
): Promise<void> {
  await updateState(input, {
    lastSha: input.tip,
    branch: input.branch,
    treeVersion: input.treeVersion,
    projectionVersion: input.projectionVersion,
    runStatus: "completed",
    failedCount: input.failedCount,
  })
}

/**
 * Record a run that stopped on an infrastructure error. The head stays, so
 * the next run deletes the tree rows above it and applies the diff from
 * `last_sha` again.
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
