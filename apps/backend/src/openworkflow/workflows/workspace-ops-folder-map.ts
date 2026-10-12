import { z } from "zod"
import { withWorkspaceWriteContext } from "../../domain/workspaces/write-command.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * Retired with the folder-map marker comments (CTX-555). The
 * `workspace-write-ops-folder-list` workflow does this job now. OpenWorkflow
 * caches step outputs by step name, so the new steps use a new workflow name.
 * This name stays registered so that a run queued before the deploy completes
 * and closes its write job; the next hydrate plans the new job when needed.
 * Delete this file one release after that change ships.
 */
const retiredInput = z.looseObject({
  orgId: z.string().min(1),
  workspaceId: z.string().min(1),
  jobId: z.string().min(1),
})

export const workspaceOpsFolderMapRetired = defineWorkflow(
  { name: "workspace-write-ops-folder-map", schema: z.looseObject({}) },
  async ({ input, step }) => {
    const parsed = retiredInput.safeParse(input)
    if (parsed.success)
      await step.run({ name: "retire-command" }, () =>
        withWorkspaceWriteContext(
          parsed.data,
          "workspace-write-ops-folder-map",
          () => persistWriteJobStatus(parsed.data.jobId, "completed"),
        ),
      )
    return { status: "retired" as const }
  },
)
