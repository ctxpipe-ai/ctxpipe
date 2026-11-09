import { persistWriteJobStatus } from "../models/workspaces.js"
import type { Step } from "./defineObservedWorkflow.js"

/**
 * Run a Workspace write step that pushes its commit to a job ref
 * (CTX-1235). While the Workspace has no write access, the step answers
 * `paused`: the job pauses, and the step runs again after a minute, as
 * `broker-push` does.
 */
export async function runJobRefStep<T>(
  step: Step,
  jobId: string,
  options: Parameters<Step["run"]>[0],
  prepare: () => Promise<T | "paused">,
): Promise<T> {
  for (;;) {
    const result = await step.run(options, prepare)
    if (result !== "paused") return result as T
    await step.run({ name: "pause-prepare" }, () =>
      persistWriteJobStatus(jobId, "paused"),
    )
    await step.sleep("await-job-ref-access", "1 minute")
    await step.run({ name: "resume-prepare" }, () =>
      persistWriteJobStatus(jobId, "running"),
    )
  }
}
