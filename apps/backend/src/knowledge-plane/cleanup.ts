import type {
  KnowledgeStore,
  MutationCounter,
} from "../knowledge-store/knowledge-store.js"
import { listBranchHeads, treeHeadOf } from "../models/knowledge-state.js"
import { getLogger } from "../observability/logger.js"

/**
 * The grace times of the cleanup (ADR-071 decision 10). A replaced tree row
 * stays for 1 hour, so that a read that started from an older head still
 * finds its rows. An unused file version stays for 1 day, so that the retry
 * of a run that stopped before it moved the head uses the file versions of
 * that run and pays no model call again.
 */
const GRACE = {
  replacedTreeRowMs: 60 * 60_000,
  unusedFileVersionMs: 24 * 60 * 60_000,
}

/**
 * Deletes the tree rows and the file versions of a Workspace that no head
 * of any of its branches can see (`KnowledgeStore.cleanUp`). The caller
 * holds the knowledge projection lease of the Workspace, the one lease of
 * all its branches, so that no run uses a file version while it is deleted
 * (ADR-071 decision 7). A Workspace with no completed run has nothing to
 * clean.
 */
export async function cleanUpKnowledgePlane(input: {
  orgId: string
  workspaceId: string
  /** A store with the writer user. */
  store: KnowledgeStore
  now: Date
}): Promise<void> {
  const scope = { orgId: input.orgId, workspaceId: input.workspaceId }
  // A head that a stopped run left keeps its rows: `treeHeadOf` gives the
  // head of its last completed run. A branch with no completed run has no
  // head, and the cleanup treats its rows as the rows of a removed branch.
  const heads = (await listBranchHeads(scope)).flatMap(
    (row) => treeHeadOf(row) ?? [],
  )
  if (heads.length === 0) return
  const counter: MutationCounter = { mutations: 0 }
  const deleted = await input.store.cleanUp(
    scope,
    {
      heads,
      replacedBefore: new Date(input.now.getTime() - GRACE.replacedTreeRowMs),
      unusedBefore: new Date(input.now.getTime() - GRACE.unusedFileVersionMs),
    },
    counter,
  )
  getLogger().set({
    knowledgeCleanup: { ...deleted, mutations: counter.mutations },
  })
}
