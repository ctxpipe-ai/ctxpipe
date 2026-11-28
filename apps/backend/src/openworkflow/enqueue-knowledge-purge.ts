import { assertNotInOrgDbContext } from "../db/client.js"
import type { PurgeScope } from "../knowledge-store/knowledge-store.js"
import { enqueueWorkflow } from "./client.js"
import { knowledgePurge } from "./workflows/knowledge-purge.js"

/**
 * Queues the purge of the knowledge plane rows of a deleted org, or of a
 * deleted Workspace (CTX-1642). Queue the purge of a Workspace before the
 * transaction that deletes the Workspace row, and the purge of an org in the
 * hook before the delete of the organization row (see `knowledgePurge`).
 */
export async function enqueueKnowledgePurge(scope: PurgeScope): Promise<void> {
  assertNotInOrgDbContext()
  await enqueueWorkflow(knowledgePurge.spec, scope)
}
