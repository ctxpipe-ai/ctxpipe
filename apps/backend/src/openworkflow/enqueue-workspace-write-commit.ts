import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceWriteCommit } from "./workflows/workspace-write-commit.js"

export async function enqueueWorkspaceWriteCommit(
  input: {
    orgId: string
    workspaceId: string
    kind: "migration_export" | "link_unlink" | "bootstrap"
    defaultBranch?: string
    linkAction?: "link" | "unlink"
    linkGitUrl?: string
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  try {
    await runWorkflowWithWorkerWake(workspaceWriteCommit.spec, input)
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
