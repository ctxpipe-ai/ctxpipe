import { and, desc, eq, inArray, isNotNull } from "drizzle-orm"

import { withOrgDbContext } from "../db/client.js"
import {
  knowledgeBranchHeads,
  knowledgeState,
} from "../db/schema/knowledge_state.js"
import { workspaces } from "../db/schema/workspaces.js"
import type { TreeHead } from "../knowledge-store/knowledge-store.js"

/**
 * The name of the knowledge projection workflow. The purge workflow reads
 * its runs by this name, and does not import the projection workflow: that
 * import pulls the workflow graph into the delete paths (an import cycle).
 */
export const KNOWLEDGE_PROJECTION_WORKFLOW_NAME = "knowledge-projection"

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

function stateRow({ orgId, workspaceId }: KnowledgeStateKey) {
  return and(
    eq(knowledgeState.organizationId, orgId),
    eq(knowledgeState.workspaceId, workspaceId),
  )
}

/** The `knowledge_state` row of a Workspace (the previous release's view). */
export async function getKnowledgeState(key: KnowledgeStateKey) {
  const [row] = await withOrgDbContext(key.orgId, (db) =>
    db.select().from(knowledgeState).where(stateRow(key)),
  )
  return row ?? null
}

/** Throw when an update found no head row: no run of the branch began. */
function requireRun(updated: unknown[], key: BranchKey): void {
  if (!updated.length)
    throw new Error(
      `The branch ${key.branch} of ${key.workspaceId} has no knowledge run; call beginKnowledgeRun first`,
    )
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
  /**
   * The count of the tree rows after the first row of their folded path
   * (`case_duplicate_rows`); null: not known.
   */
  caseDuplicateRows: number | null
  base?: TreeHead & { sha: string }
}

/**
 * The key of the view of a head, for the binding of a cursor or a cache:
 * the branch, the tree version and the tip of the head, and for an overlay
 * the same of its base, because a new tree of the default branch changes
 * the view of an overlay too. A tree version changes also at the same tip,
 * for example after a new projection version.
 */
export const knowledgeViewKey = (head: KnowledgeHead) =>
  JSON.stringify(
    [head, head.base].flatMap((tree) =>
      tree ? [[tree.branch, tree.treeVersion, tree.sha]] : [],
    ),
  )

type HeadRow = typeof knowledgeBranchHeads.$inferSelect

/** The tree head of a completed head row, or null before its first run. */
export function treeHeadOf(row: HeadRow | null): TreeHead | null {
  return row?.lastSha
    ? { branch: row.branch, treeVersion: row.treeVersion }
    : null
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
      heads.set(workspaceId, {
        sha: base.lastSha ?? "",
        caseDuplicateRows: base.caseDuplicateRows,
        ...baseHead,
      })
      continue
    }
    const overlay = rows.find(
      (row) =>
        row.workspaceId === workspaceId &&
        row.branch === branch &&
        row.baseBranch !== null,
    )
    if (overlay?.lastSha)
      heads.set(workspaceId, {
        sha: overlay.lastSha,
        caseDuplicateRows: overlay.caseDuplicateRows,
        branch,
        treeVersion: overlay.treeVersion,
        base: { ...baseHead, sha: base.lastSha ?? "" },
      })
  }
  return heads
}

/**
 * The tip of the default branch of each Workspace of the org that has a
 * ready head, with the count of the hidden copies of the files of that tip
 * (`case_duplicates`, CTX-1697). Null when a run of an earlier release made
 * the head.
 */
export async function defaultCaseDuplicates(
  orgId: string,
): Promise<Map<string, { sha: string; caseDuplicates: number | null }>> {
  const rows = await withOrgDbContext(orgId, (db) =>
    db
      .select()
      .from(knowledgeBranchHeads)
      .where(
        and(
          eq(knowledgeBranchHeads.organizationId, orgId),
          isNotNull(knowledgeBranchHeads.lastSha),
        ),
      ),
  )
  return new Map(
    [...defaultHeads(rows)].map(([workspaceId, row]) => [
      workspaceId,
      { sha: row.lastSha ?? "", caseDuplicates: row.caseDuplicates },
    ]),
  )
}

/**
 * Insert or update the head row of a branch with `runStatus`. The Workspace
 * must belong to the org: the foreign key does not check the org, so without
 * this check an org could take the row of a Workspace of another org.
 */
async function upsertHeadStatus(
  db: Parameters<Parameters<typeof withOrgDbContext>[1]>[0],
  key: BranchKey,
  runStatus: "running" | "waiting",
): Promise<void> {
  const [workspace] = await db
    .select({ id: workspaces.id })
    .from(workspaces)
    .where(
      and(eq(workspaces.orgId, key.orgId), eq(workspaces.id, key.workspaceId)),
    )
  if (!workspace)
    throw new Error(`The org ${key.orgId} has no Workspace ${key.workspaceId}`)
  await db
    .insert(knowledgeBranchHeads)
    .values({
      workspaceId: key.workspaceId,
      organizationId: key.orgId,
      branch: key.branch,
      runStatus,
    })
    .onConflictDoUpdate({
      target: [knowledgeBranchHeads.workspaceId, knowledgeBranchHeads.branch],
      set: { runStatus, updatedAt: new Date() },
    })
}

/**
 * Mark the run of a branch as `running` before it writes a row; for the
 * default branch, also `knowledge_state`.
 */
export async function beginKnowledgeRun(
  input: BranchKey & { isDefault: boolean },
): Promise<void> {
  await withOrgDbContext(input.orgId, async (db) => {
    await upsertHeadStatus(db, input, "running")
    const now = new Date()
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
 * branch (a full tree, `baseBranch` null) also sets `default_at` and the
 * `knowledge_state` row of the previous release.
 */
export async function completeKnowledgeRun(
  input: BranchKey & {
    tip: string
    treeVersion: number
    /** The default branch of the tree of an overlay; null for a full tree. */
    baseBranch: string | null
    projectionVersion: string
    /** The count of `failed` documents (ADR-067 decisions 8 and 11). */
    failedCount: number
    /** The case duplicate rows of the tree (CTX-1697). */
    caseDuplicateRows: number
    /** The hidden copies of the files of the tip (CTX-1697). */
    caseDuplicates: number
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
          baseBranch: input.baseBranch,
          projectionVersion: input.projectionVersion,
          runStatus: "completed",
          failedCount: input.failedCount,
          caseDuplicateRows: input.caseDuplicateRows,
          caseDuplicates: input.caseDuplicates,
          defaultAt: input.baseBranch === null ? now : null,
          updatedAt: now,
        })
        .where(headRow(input))
        .returning({ branch: knowledgeBranchHeads.branch })
      requireRun(updated, input)
      if (input.baseBranch === null)
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
          .where(stateRow(input))
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
    requireRun(updated, input)
    if (input.isDefault)
      await db
        .update(knowledgeState)
        .set({ runStatus: "failed", updatedAt: now })
        .where(stateRow(input))
  })
}

/**
 * Record a branch that waits for the first head of the default branch, its
 * base: the first completed run of the default branch queues it again. Its
 * head does not change.
 */
export async function markBranchWaiting(key: BranchKey): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    upsertHeadStatus(db, key, "waiting"),
  )
}

/** Delete the head row of a branch that Git no longer has (ADR-071 decision 10). */
export async function deleteBranchHead(key: BranchKey): Promise<void> {
  await withOrgDbContext(key.orgId, (db) =>
    db.delete(knowledgeBranchHeads).where(headRow(key)),
  )
}

/**
 * Delete the knowledge state and the head rows of each Workspace of a
 * deleted org (CTX-1642). The purge of the org calls it after no projection
 * run of the org runs: such a run can write these rows again, because the
 * Workspace rows of a deleted org stay.
 */
export async function deleteOrgKnowledgeState(orgId: string): Promise<void> {
  await withOrgDbContext(orgId, async (db) => {
    await db
      .delete(knowledgeBranchHeads)
      .where(eq(knowledgeBranchHeads.organizationId, orgId))
    await db
      .delete(knowledgeState)
      .where(eq(knowledgeState.organizationId, orgId))
  })
}
