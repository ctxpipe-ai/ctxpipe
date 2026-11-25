import {
  releaseWorkspaceMergeLease,
  takeWorkspaceMergeLease,
  workspaceMergeWakeSignal,
} from "../domain/workspaces/merge-lease.js"
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
