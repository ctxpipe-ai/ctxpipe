import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import {
  knowledgeBranchHeads,
  knowledgeState,
} from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { TreeHead } from "../knowledge-store/knowledge-store.js"

/*
 * The heads of the knowledge projection (ADR-071 decision 4): one row of
 * `knowledge_branch_heads` for each projected branch of a Workspace, the
 * default branch included. `knowledge_state` stays only as the view of the
 * default branch for the previous release (ADR-053): a run of the default
 * branch updates it in the same transaction. The knowledge projection lease
 * lets one run of a Workspace run at a time, so these updates need no
 * compare-and-set.
 */

type KnowledgeStateKey = { orgId: string; workspaceId: string }
type BranchKey = KnowledgeStateKey & { branch: string }

/** The `knowledge_state` row of a Workspace (the previous release's view). */
export async function getKnowledgeState(key: KnowledgeStateKey) {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db
      .select()
      .from(knowledgeState)
      .where(
        and(
          eq(knowledgeState.organizationId, key.orgId),
          eq(knowledgeState.workspaceId, key.workspaceId),
        ),
      ),
  )
  return row ?? null
}

function headRow({ orgId, workspaceId, branch }: BranchKey) {
  return and(
    eq(knowledgeBranchHeads.organizationId, orgId),
    eq(knowledgeBranchHeads.workspaceId, workspaceId),
    eq(knowledgeBranchHeads.branch, branch),
  )
}

/** The head row of a branch, or null before its first run. */
export async function getBranchHead(key: BranchKey) {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db.select().from(knowledgeBranchHeads).where(headRow(key)),
  )
  return row ?? null
}

/** The head rows of each branch of a Workspace. */
export async function listBranchHeads(key: KnowledgeStateKey) {
  return withOrgDbContext(key.orgId, (db) =>
    db
      .select()
      .from(knowledgeBranchHeads)
      .where(
        and(
          eq(knowledgeBranchHeads.organizationId, key.orgId),
          eq(knowledgeBranchHeads.workspaceId, key.workspaceId),
        ),
      ),
  )
}

/**
 * The head that a read uses for one Workspace (ADR-071 decisions 4 and 5).
 * `branch` and `treeVersion` name the tree of the branch. For a branch that
 * is not the default branch, that tree is an overlay, and `base` is the head
 * of the default branch, on which the read applies it.
 */
export type KnowledgeHead = TreeHead & {
  /** The tip that the last completed run of the branch applied. */
  sha: string
  base?: TreeHead
}

type HeadRow = typeof knowledgeBranchHeads.$inferSelect

/** The tree head of a completed head row, or null before its first run. */
export function treeHeadOf(row: HeadRow | null): TreeHead | null {
  return row?.lastSha ? { branch: row.branch, treeVersion: row.treeVersion } : null
}

/**
 * The head of the default branch of each Workspace of `rows`: the full tree
 * that most recently became the tree of the default branch (`default_at`).
 * During a rename, that is the earlier default branch until the first run
 * of the new one completes (ADR-071 decision 11).
 */
function defaultHeads(rows: HeadRow[]): Map<string, HeadRow> {
  const heads = new Map<string, HeadRow>()
  for (const row of rows) {
    if (!row.lastSha || !row.defaultAt) continue
    const known = heads.get(row.workspaceId)
    if (!known?.defaultAt || known.defaultAt < row.defaultAt)
      heads.set(row.workspaceId, row)
  }
  return heads
}

/**
 * The read head of each Workspace whose projection of `branch` is ready: a
 * run applied a tip of the branch in full. Without `branch`, the head of
 * the default branch. A branch that is not the default branch also needs a
 * ready default branch, the base of its overlay. A later run that is
 * `running` or `failed` does not change a head: a read sees only the tree
 * rows at or below it. A Workspace with no ready head is not in the map.
 */
export async function readyKnowledgeHeads(
  orgId: string,
  workspaceIds: readonly string[],
  branch?: string,
): Promise<Map<string, KnowledgeHead>> {
  if (workspaceIds.length === 0) return new Map()
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(knowledgeBranchHeads)
      .where(
        and(
          eq(knowledgeBranchHeads.organizationId, orgId),
          inArray(knowledgeBranchHeads.workspaceId, [...workspaceIds]),
          isNotNull(knowledgeBranchHeads.lastSha),
        ),
      )
      .orderBy(desc(knowledgeBranchHeads.updatedAt)),
  )
  const defaults = defaultHeads(rows)
  const heads = new Map<string, KnowledgeHead>()
  for (const [workspaceId, base] of defaults) {
    const baseHead = { branch: base.branch, treeVersion: base.treeVersion }
    if (branch === undefined || branch === base.branch) {
      heads.set(workspaceId, { sha: base.lastSha ?? "", ...baseHead })
      continue
    }
    const overlay = rows.find(
      (row) =>
        row.workspaceId === workspaceId &&
        row.branch === branch &&
        row.mergeBase !== null,
    )
    if (overlay?.lastSha)
      heads.set(workspaceId, {
        sha: overlay.lastSha,
        branch,
        treeVersion: overlay.treeVersion,
        base: baseHead,
      })
  }
  return heads
}

/**
 * Mark the run of a branch as `running` before it writes a row; for the
 * default branch, also `knowledge_state`. The Workspace must belong to the
 * org: the foreign key does not check the org, so without this check an
 * org could take the row of a Workspace of another org.
 */
export async function beginKnowledgeRun(
  input: BranchKey & { isDefault: boolean },
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
    const now = new Date()
    await db
      .insert(knowledgeBranchHeads)
      .values({
        workspaceId: input.workspaceId,
        organizationId: input.orgId,
        branch: input.branch,
        runStatus: "running",
      })
      .onConflictDoUpdate({
        target: [knowledgeBranchHeads.workspaceId, knowledgeBranchHeads.branch],
        set: { runStatus: "running", updatedAt: now },
      })
    if (input.isDefault)
      await db
        .insert(knowledgeState)
        .values({
          workspaceId: input.workspaceId,
          organizationId: input.orgId,
          runStatus: "running",
        })
        .onConflictDoUpdate({
          target: knowledgeState.workspaceId,
          set: { runStatus: "running", updatedAt: now },
        })
  })
}

/**
 * Record a run that applied all of its work: the head of the branch moves
 * to the tip and to the tree version of the run, in one transaction.
 * Until then, no read sees the tree rows of the run. A run of the default
 * branch (a full tree, `mergeBase` null) also sets `default_at` and the
 * `knowledge_state` row of the previous release.
 */
export async function completeKnowledgeRun(
  input: BranchKey & {
    tip: string
    treeVersion: number
    /** The merge base of an overlay; null for the full tree of the default branch. */
    mergeBase: string | null
    projectionVersion: string
    /** The count of `failed` documents (ADR-067 decisions 8 and 11). */
    failedCount: number
  },
): Promise<void> {
  const now = new Date()
  await withOrgDbContext(input.orgId, async (db) => {
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(knowledgeBranchHeads)
        .set({
          lastSha: input.tip,
          treeVersion: input.treeVersion,
          mergeBase: input.mergeBase,
          projectionVersion: input.projectionVersion,
          runStatus: "completed",
          failedCount: input.failedCount,
          defaultAt: input.mergeBase === null ? now : null,
          updatedAt: now,
        })
        .where(headRow(input))
        .returning({ branch: knowledgeBranchHeads.branch })
      if (!updated.length)
        throw new Error(
          `The branch ${input.branch} of ${input.workspaceId} has no knowledge run; call beginKnowledgeRun first`,
        )
      if (input.mergeBase === null)
        await tx
          .update(knowledgeState)
          .set({
            lastSha: input.tip,
            attemptShas: [],
            branch: input.branch,
            treeVersion: input.treeVersion,
            projectionVersion: input.projectionVersion,
            runStatus: "completed",
            failedCount: input.failedCount,
            updatedAt: now,
          })
          .where(
            and(
              eq(knowledgeState.organizationId, input.orgId),
              eq(knowledgeState.workspaceId, input.workspaceId),
            ),
          )
    })
  })
}

/**
 * Record a run that stopped on an infrastructure error. The head stays, so
 * the next run deletes the tree rows above it and applies the diff from
 * `last_sha` again.
 */
export async function failKnowledgeRun(
  input: BranchKey & { isDefault: boolean },
): Promise<void> {
  const now = new Date()
  await withOrgDbContext(input.orgId, async (db) => {
    const updated = await db
      .update(knowledgeBranchHeads)
      .set({ runStatus: "failed", updatedAt: now })
      .where(headRow(input))
      .returning({ branch: knowledgeBranchHeads.branch })
    if (!updated.length)
      throw new Error(
        `The branch ${input.branch} of ${input.workspaceId} has no knowledge run; call beginKnowledgeRun first`,
      )
    if (input.isDefault)
      await db
        .update(knowledgeState)
        .set({ runStatus: "failed", updatedAt: now })
        .where(
          and(
            eq(knowledgeState.organizationId, input.orgId),
            eq(knowledgeState.workspaceId, input.workspaceId),
          ),
        )
  })
}

/** Delete the head row of a branch that Git no longer has (ADR-071 decision 10). */
export async function deleteBranchHead(key: BranchKey): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    db.delete(knowledgeBranchHeads).where(headRow(key)),
  )
}
