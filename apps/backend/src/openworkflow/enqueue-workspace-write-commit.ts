import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import { generateObjectId } from "../lib/id.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceWriteCommit } from "./workflows/workspace-write-commit.js"

export async function enqueueWorkspaceWriteCommit(
  input: {
    orgId: string
    workspaceId: string
    kind: WorkspaceWriteKind
    defaultBranch?: string
    jobId?: string
    linkAction?: "link" | "unlink"
    linkGitUrl?: string
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  const jobId = input.jobId ?? generateObjectId("wjob")
  try {
    await runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
      ...input,
      jobId,
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
