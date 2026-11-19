import { and, eq, sql } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import { knowledgeState } from "../db/schema/knowledge_state.js"

/*
 * The state updates of a knowledge run (ADR-067 decisions 2, 4 and 8). The
 * hydrate lease lock lets one run of a Workspace run at a time, so these
 * updates need no compare-and-set.
 */

type Workspace = { orgId: string; workspaceId: string }

/** The state row of a Workspace, or null before its first run. */
export async function getKnowledgeState({ orgId, workspaceId }: Workspace) {
  const [row] = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(knowledgeState)
      .where(
        and(
          eq(knowledgeState.orgId, orgId),
          eq(knowledgeState.workspaceId, workspaceId),
        ),
      ),
  )
  return row ?? null
}

/**
 * Add the tip to `attempt_shas` before the run writes a row. The list only
 * grows, so a crash at any point loses no SHA. A retry of the same tip adds
 * nothing.
 */
export async function beginKnowledgeRun(
  input: Workspace & { tip: string },
): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .insert(knowledgeState)
      .values({
        workspaceId: input.workspaceId,
        orgId: input.orgId,
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
      }),
  )
}

/**
 * Record a run that applied all of its work: `last_sha` moves to the tip,
 * and `attempt_shas` becomes empty, in one update.
 */
export async function completeKnowledgeRun(
  input: Workspace & {
    tip: string
    projectionVersion: string
    failedCount: number
  },
): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(knowledgeState)
      .set({
        lastSha: input.tip,
        attemptShas: [],
        projectionVersion: input.projectionVersion,
        runStatus: "completed",
        failedCount: input.failedCount,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(knowledgeState.orgId, input.orgId),
          eq(knowledgeState.workspaceId, input.workspaceId),
        ),
      ),
  )
}

/**
 * Record a run that stopped on an infrastructure error. `last_sha` and
 * `attempt_shas` stay, so the next run applies the same files again.
 */
export async function failKnowledgeRun(input: Workspace): Promise<void> {
  await withOrgDbContext(input.orgId, (db) =>
    db
      .update(knowledgeState)
      .set({ runStatus: "failed", updatedAt: new Date() })
      .where(
        and(
          eq(knowledgeState.orgId, input.orgId),
          eq(knowledgeState.workspaceId, input.workspaceId),
        ),
      ),
  )
}
