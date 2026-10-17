import { assertNotInOrgDbContext } from "../db/client.js"
import type {
  LinkedRevision,
  WorkspaceRevision,
} from "../domain/workspaces/revision.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceIndex } from "./workflows/workspace-index.js"

export async function enqueueWorkspaceIndex(
  input: {
    orgId: string
    revision: WorkspaceRevision
    linked?: LinkedRevision
  },
  log: { error: (err: Error) => void },
  options?: { idempotencyKey: string },
): Promise<void> {
  assertNotInOrgDbContext()
  try {
    await runWorkflowWithWorkerWake(workspaceIndex.spec, input, options)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
