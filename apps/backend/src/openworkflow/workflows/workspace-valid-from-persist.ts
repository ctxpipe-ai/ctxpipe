import { z } from "zod"

import { withOrgDbContext } from "../../db/client.js"
import { persistWriteJobStatus } from "../../models/workspaces.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * Retired (CTX-1710): ctxpipe does not write `valid_from` into Workspace
 * files any more. Retrieval reads the times of each file as the file states
 * them (`documentTimes`). Workers retry a run of an unregistered workflow
 * forever, so this name ends a run that an earlier release queued: its write
 * job completes with no commit. Delete this file one release after this
 * change ships.
 */
export const workspaceValidFromPersistRetired = defineWorkflow(
  {
    name: "workspace-write-valid-from-persist",
    schema: z.looseObject({ orgId: z.string(), jobId: z.string() }),
  },
  async ({ input, step }) => {
    await step.run({ name: "retire-command" }, () =>
      withOrgDbContext(input.orgId, () =>
        persistWriteJobStatus(
          input.jobId,
          "completed",
          "ctxpipe does not write valid_from into Workspace files any more.",
        ),
      ),
    )
    return { status: "retired" as const }
  },
)
