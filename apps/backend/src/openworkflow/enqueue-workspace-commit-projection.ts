import { assertNotInOrgDbContext } from "../db/client.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceCommitProjection } from "./workflows/workspace-commit-projection.js"

export async function enqueueWorkspaceCommitProjection(
  input: {
    orgId: string
    workspaceId: string
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  assertNotInOrgDbContext()
  try {
    await runWorkflowWithWorkerWake(workspaceCommitProjection.spec, input)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
