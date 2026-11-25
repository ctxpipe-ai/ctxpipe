import type { PurgeScope } from "../knowledge-store/knowledge-store.js"
import { enqueueWorkflow } from "./client.js"
import { knowledgePurge } from "./workflows/knowledge-purge.js"

/**
 * Queues the purge of the knowledge plane rows of a deleted org, or of a
 * deleted Workspace (CTX-1642). Call it after the delete of the Postgres
 * rows commits: the purge waits only for the projection runs that started
 * before that delete.
 */
export async function enqueueKnowledgePurge(scope: PurgeScope): Promise<void> {
  await enqueueWorkflow(knowledgePurge.spec, scope)
}
