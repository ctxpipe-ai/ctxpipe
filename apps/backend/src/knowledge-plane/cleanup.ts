import type {
  KnowledgeStore,
  MutationCounter,
} from "../knowledge-store/knowledge-store.js"
import { getKnowledgeState, treeHeadOf } from "../models/knowledge-state.js"
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
 * can see (`KnowledgeStore.cleanUp`). The caller holds the knowledge
 * projection lease of the Workspace, so that no run uses a file version
 * while it is deleted. A Workspace with no completed run has nothing to
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
  const state = await getKnowledgeState(scope)
  const head = treeHeadOf(state)
  if (state?.runStatus !== "completed" || !head) return
  const counter: MutationCounter = { mutations: 0 }
  const deleted = await input.store.cleanUp(
    scope,
    {
      heads: [head],
      replacedBefore: new Date(input.now.getTime() - GRACE.replacedTreeRowMs),
      unusedBefore: new Date(input.now.getTime() - GRACE.unusedFileVersionMs),
    },
    counter,
  )
  getLogger().set({
    knowledgeCleanup: { ...deleted, mutations: counter.mutations },
  })
}
