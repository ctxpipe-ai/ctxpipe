import { z } from "zod"

import { parseEnv } from "../../config/env.js"
import { openCaseMergePullRequest } from "../../domain/workspaces/case-repair.js"
import { withWorkspaceWriteContext } from "../../domain/workspaces/write-command.js"
import { getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The pull request of the case duplicate repair (CTX-1697): the edited
 * copies of a file that differ merge into the canonical path, and a person
 * decides. The tip check queues it, one time for each tip that the
 * knowledge plane projected with a hidden case duplicate. It plans on the tip that the Workspace wants when
 * it runs, and it does not write the default branch.
 */
export const workspaceCaseMerge = defineWorkflow(
  {
    name: "workspace-case-merge",
    schema: z
      .object({
        orgId: z.string().min(1),
        workspaceId: z.string().min(1),
      })
      .strict(),
  },
  async ({ input, step, run }) =>
    withWorkspaceWriteContext(
      { ...input, jobId: `case-merge:${run.id}` },
      "workspace-case-merge",
      async () => {
        const result = await step.run({ name: "open-pull-request" }, () =>
          openCaseMergePullRequest({
            orgId: input.orgId,
            workspaceId: input.workspaceId,
            env: parseEnv(process.env),
            createdAt: run.createdAt,
          }),
        )
        // The kind and the count only: no file and no title.
        getLogger().info("case_repair.pull_request", {
          workspaceId: input.workspaceId,
          kind: result.kind,
          ...(result.kind === "open" && {
            merges: result.merges,
            deferred: result.deferred,
          }),
          ...(result.kind === "refused" && { reason: result.reason }),
        })
        return result
      },
    ),
)
