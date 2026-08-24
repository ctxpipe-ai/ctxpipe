import { assertNotInOrgDbContext, withOrgDbContext } from "../db/client.js"
import type { WorkspaceWriteKind } from "../domain/workspaces/write-commit-files.js"
import {
  WRITE_JOB_STATUSES,
  writeJobIntentPayload,
  writeJobIntentStatus,
} from "../domain/workspaces/write-job-intent.js"
import { probeWorkspaceWriteAccess } from "../domain/workspaces/write-status.js"
import { generateObjectId } from "../lib/id.js"
import {
  getWorkspaceById,
  persistHydrateFailure,
  persistWriteJobIntent,
  persistWriteJobStatus,
  persistWriteStatus,
} from "../models/workspaces.js"
import { runWorkflowWithWorkerWake } from "./client.js"
import { workspaceWriteCommit } from "./workflows/workspace-write-commit.js"

type WorkspaceWriteSnapshot = {
  id: string
  desiredGeneration: number
  workspaceRepositoryUrl: string
  desiredSha: string | null
  writeStatus: string
  githubConnectionId?: string | null
}

async function probedWriteStatus(input: {
  orgId: string
  workspace: WorkspaceWriteSnapshot
}): Promise<string> {
  if (input.workspace.writeStatus === "writable") {
    return input.workspace.writeStatus
  }
  try {
    const probe = await probeWorkspaceWriteAccess({
      workspaceRepositoryUrl: input.workspace.workspaceRepositoryUrl,
      githubConnectionId: input.workspace.githubConnectionId,
    })
    await withOrgDbContext(input.orgId, () =>
      persistWriteStatus(input.workspace.id, probe, input.orgId),
    )
    return probe.writeStatus
  } catch {
    return input.workspace.writeStatus
  }
}

export type EnqueueWorkspaceWriteCommitInput = {
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
  mergeFiles?: Array<{ path: string; content: string }>
  mergeDeletePaths?: string[]
}

export async function enqueueWorkspaceWriteCommit(
  input: EnqueueWorkspaceWriteCommitInput,
  log: { error: (err: Error) => void },
): Promise<{ started: boolean }> {
  assertNotInOrgDbContext()
  const jobId = input.jobId ?? generateObjectId("wjob")
  let jobGeneration = input.jobGeneration
  let jobWorkspaceUrl = input.jobWorkspaceUrl
  let jobDesiredSha = input.jobDesiredSha
  let writeStatus: string | null = null
  let desiredGeneration = jobGeneration
  try {
    const workspace = await withOrgDbContext(input.orgId, () =>
      getWorkspaceById(input.workspaceId),
    )
    if (workspace) {
      jobGeneration = jobGeneration ?? workspace.desiredGeneration
      jobWorkspaceUrl = jobWorkspaceUrl ?? workspace.workspaceRepositoryUrl
      if (jobDesiredSha === undefined) jobDesiredSha = workspace.desiredSha
      desiredGeneration = workspace.desiredGeneration
      writeStatus = await probedWriteStatus({
        orgId: input.orgId,
        workspace: {
          id: workspace.id,
          desiredGeneration: workspace.desiredGeneration,
          workspaceRepositoryUrl: workspace.workspaceRepositoryUrl,
          desiredSha: workspace.desiredSha,
          writeStatus: workspace.writeStatus,
          githubConnectionId: workspace.githubConnectionId,
        },
      })
    }
  } catch {
    // Workflow loads live state if enqueue cannot snapshot the Workspace.
  }
  if (writeStatus == null) {
    try {
      await runWorkflowWithWorkerWake(workspaceWriteCommit.spec, {
        ...input,
        jobId,
        ...(jobGeneration != null ? { jobGeneration } : {}),
        ...(jobWorkspaceUrl ? { jobWorkspaceUrl } : {}),
        ...(jobDesiredSha !== undefined ? { jobDesiredSha } : {}),
      })
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err))
      log.error(error)
      return { started: false }
    }
    return { started: true }
  }
  const generation = jobGeneration ?? desiredGeneration ?? 1
  const intent = writeJobIntentStatus({
    writeStatus,
    jobGeneration: generation,
    desiredGeneration: desiredGeneration ?? generation,
  })
  const status =
    intent === "stale_generation"
      ? WRITE_JOB_STATUSES.failed
      : intent === WRITE_JOB_STATUSES.paused
        ? WRITE_JOB_STATUSES.paused
        : WRITE_JOB_STATUSES.queued
  try {
    await withOrgDbContext(input.orgId, () =>
      persistWriteJobIntent({
        id: jobId,
        workspaceId: input.workspaceId,
        kind: input.kind,
        generation,
        desiredSha: jobDesiredSha ?? null,
        status,
        payload: writeJobIntentPayload({
          kind: input.kind,
          defaultBranch: input.defaultBranch,
          linkAction: input.linkAction,
          linkGitUrl: input.linkGitUrl,
          jobWorkspaceUrl,
          conflictParentSha: input.conflictParentSha,
          remoteTipSha: input.remoteTipSha,
          mergeFiles: input.mergeFiles,
          mergeDeletePaths: input.mergeDeletePaths,
        }),
      }),
    )
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      await withOrgDbContext(input.orgId, () =>
        persistHydrateFailure({
          workspaceId: input.workspaceId,
          message: error.message,
        }),
      )
    } catch {
      // Persist is best-effort when org db is not open.
    }
    if (status !== WRITE_JOB_STATUSES.queued) return { started: false }
  }
  if (status !== WRITE_JOB_STATUSES.queued) {
    return { started: false }
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
    const error = err instanceof Error ? err : new Error(String(err))
    log.error(error)
    try {
      await withOrgDbContext(input.orgId, () =>
        persistWriteJobStatus(jobId, WRITE_JOB_STATUSES.paused),
      )
    } catch {
      // Keep a resumable row even if this status write fails.
    }
    return { started: false }
  }
  return { started: true }
}
