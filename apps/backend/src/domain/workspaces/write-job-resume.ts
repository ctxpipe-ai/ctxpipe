import type { WorkspaceWriteKind } from "./write-commit-files.js"
import {
  enqueueInputFromPausedJob,
  shouldResumePausedWriteJob,
  type WorkspaceWriteJobPayload,
} from "./write-job-intent.js"

export type PausedWriteJobRow = {
  id: string
  kind: WorkspaceWriteKind
  generation: number
  desiredSha: string | null
  status: string
  payload: WorkspaceWriteJobPayload | null
}

export async function resumePausedWriteJobs(input: {
  orgId: string
  workspaceId: string
  writeStatus: string
  desiredGeneration: number
  desiredWorkspaceUrl: string
  jobs: readonly PausedWriteJobRow[]
  claim: (jobId: string) => Promise<boolean>
  enqueue: (
    args: ReturnType<typeof enqueueInputFromPausedJob>,
    log: { error: (err: Error) => void },
  ) => Promise<{ started: boolean } | undefined>
  log: { error: (err: Error) => void }
}): Promise<string[]> {
  const resumed: string[] = []
  for (const job of input.jobs) {
    const jobWorkspaceUrl =
      job.payload?.jobWorkspaceUrl ?? input.desiredWorkspaceUrl
    if (
      !shouldResumePausedWriteJob({
        status: job.status,
        generation: job.generation,
        desiredGeneration: input.desiredGeneration,
        writeStatus: input.writeStatus,
        jobWorkspaceUrl,
        desiredWorkspaceUrl: input.desiredWorkspaceUrl,
      })
    ) {
      continue
    }
    const claimed = await input.claim(job.id)
    if (!claimed) continue
    await input.enqueue(
      enqueueInputFromPausedJob({
        orgId: input.orgId,
        workspaceId: input.workspaceId,
        job,
      }),
      input.log,
    )
    resumed.push(job.id)
  }
  return resumed
}
