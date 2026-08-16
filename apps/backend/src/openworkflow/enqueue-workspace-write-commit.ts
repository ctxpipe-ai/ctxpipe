import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import { generateObjectId } from "../lib/id.js"
import { getWorkspaceById } from "../models/workspaces.js"
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
    jobGeneration?: number
    jobWorkspaceUrl?: string
    jobDesiredSha?: string | null
    conflictParentSha?: string | null
    remoteTipSha?: string | null
  },
  log: { error: (err: Error) => void },
): Promise<void> {
  const jobId = input.jobId ?? generateObjectId("wjob")
  let jobGeneration = input.jobGeneration
  let jobWorkspaceUrl = input.jobWorkspaceUrl
  let jobDesiredSha = input.jobDesiredSha
  if (jobGeneration == null || !jobWorkspaceUrl) {
    try {
      const workspace = await getWorkspaceById(input.workspaceId)
      if (workspace) {
        jobGeneration = workspace.desiredGeneration
        jobWorkspaceUrl = workspace.workspaceRepositoryUrl
        jobDesiredSha = workspace.desiredSha
      }
    } catch {
      // Workflow loads live state if enqueue cannot snapshot the Workspace.
    }
  }
  try {
    await runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
      ...input,
      jobId,
      ...(jobGeneration != null ? { jobGeneration } : {}),
      ...(jobWorkspaceUrl ? { jobWorkspaceUrl } : {}),
      ...(jobDesiredSha !== undefined ? { jobDesiredSha } : {}),
    })
  } catch (err: unknown) {
    log.error(err instanceof Error ? err : new Error(String(err)))
  }
}
