import type { Env } from "../config/env.js"
import {
  releaseWorkspaceMergeLease,
  takeWorkspaceMergeLease,
  workspaceMergeWakeSignal,
} from "../domain/workspaces/merge-lease.js"
import type { WorkspaceRevision } from "../domain/workspaces/revision.js"
import { refreshWorkspaceWriteRevision } from "../domain/workspaces/write-broker.js"
import { acquireWorkspaceWriteRevision } from "../domain/workspaces/write-command.js"
import {
  getWorkspaceWriteAdmission,
  persistWriteJobStatus,
} from "../models/workspaces.js"
import { ow } from "./client.js"

/** The steps that the lease uses; openworkflow does not export its type. */
type LeaseStep = {
  run<T>(config: { name: string }, fn: () => Promise<T>): Promise<T>
  waitForSignal(options: {
    name: string
    signal: string
    timeout: "30 seconds" | "10 minutes"
  }): Promise<unknown>
}

/**
 * Take the lease of the Workspace for the run, as steps (CTX-1598, ADR-047),
 * and give the step that releases it. One semantic merge or ingestion
 * publish of a Workspace runs at a time (CTX-1621), so that they do not race
 * on the default branch. A run that finds the lease busy waits in order,
 * without a worker slot, until the run before it wakes it. Only the first
 * waiter checks the lease again on a short timeout: a holder that ended
 * without a release, or a wake before the wait starts, costs that timeout.
 * A runtime that runs one key in series would replace this: see the top of
 * merge-lease.ts.
 */
export async function holdWorkspaceMergeLease(
  step: LeaseStep,
  lease: { orgId: string; workspaceId: string; runId: string },
): Promise<{ release: () => Promise<void> }> {
  const wake = (runId: string | undefined) =>
    runId
      ? ow.sendSignal({ signal: workspaceMergeWakeSignal(runId) })
      : undefined
  for (;;) {
    const taken = await step.run({ name: "take-merge-lease" }, async () => {
      const result = await takeWorkspaceMergeLease(lease)
      // The next waiter is first now: it waits on the short timeout.
      if (result.taken) await wake(result.wake)
      return result
    })
    if (taken.taken) break
    await step.waitForSignal({
      name: "await-merge-lease",
      signal: workspaceMergeWakeSignal(lease.runId),
      timeout: taken.first ? "30 seconds" : "10 minutes",
    })
  }
  return {
    release: () =>
      step.run({ name: "release-merge-lease" }, async () => {
        await wake(await releaseWorkspaceMergeLease(lease))
      }),
  }
}

type WriteCommand = Parameters<typeof acquireWorkspaceWriteRevision>[0]
type Acquired = NonNullable<
  Awaited<ReturnType<typeof acquireWorkspaceWriteRevision>>
>

/** The steps that the acquire uses; openworkflow does not export its type. */
type AcquireStep = {
  run<T>(
    config: { name: string; retryPolicy?: { maximumAttempts: number } },
    fn: () => Promise<T>,
  ): Promise<T>
  sleep(name: string, duration: "1 minute"): Promise<void>
}

/**
 * Acquire the write revision of a run that holds the lease. On the first
 * attempt (`refresh`) the acquire reads the tip of now (CTX-1598): the queued
 * revision can be hours old, and other runs of the Workspace can push while
 * this run waits for the lease. Thus the run writes onto the tip, not onto
 * an old tip that its push then loses to. The refresh is in the step, so a
 * replay gives the revision of the pack again. An output from before the
 * refresh has no revision. Without write access, the acquire pauses the job,
 * and the acquire after the pause reads the tip.
 */
export async function acquireOnCurrentTip(
  step: AcquireStep,
  command: WriteCommand & { jobId: string; previousSha?: string },
  revision: WorkspaceRevision,
  env: Env,
  options: { refresh: boolean; retryPolicy?: { maximumAttempts: number } },
): Promise<{ acquired: Acquired; revision: WorkspaceRevision }> {
  for (;;) {
    const candidate = await step.run(
      {
        name: "acquire-revision-v2",
        ...(options.retryPolicy ? { retryPolicy: options.retryPolicy } : {}),
      },
      async (): Promise<
        (Acquired & { revision?: WorkspaceRevision }) | null
      > => {
        // The refresh reads only the tip: the acquire checks the connector
        // mirror on it.
        const current =
          options.refresh &&
          (await getWorkspaceWriteAdmission(command.workspaceId))
            ?.writeStatus === "writable"
            ? await refreshWorkspaceWriteRevision(
                { orgId: command.orgId, workspaceId: command.workspaceId },
                revision,
                env,
              )
            : revision
        const acquired = await acquireWorkspaceWriteRevision(
          command,
          current,
          env,
          command.previousSha,
        )
        return acquired && { ...acquired, revision: current }
      },
    )
    if (candidate)
      return { acquired: candidate, revision: candidate.revision ?? revision }
    await step.run({ name: "pause-command" }, () =>
      persistWriteJobStatus(command.jobId, "paused"),
    )
    await step.sleep("await-write-access", "1 minute")
    await step.run({ name: "resume-command" }, () =>
      persistWriteJobStatus(command.jobId, "running"),
    )
  }
}
