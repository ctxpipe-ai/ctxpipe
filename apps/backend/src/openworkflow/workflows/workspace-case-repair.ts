import { z } from "zod"

import { planCaseRepair } from "../../domain/workspaces/case-repair.js"
import { workspaceRevisionSchema } from "../../domain/workspaces/revision.js"
import { getLogger } from "../../observability/logger.js"
import { defineReplanningHostWriteWorkflow } from "./workspace-replanning-host-write.js"

/**
 * The direct commit of the case duplicate repair (CTX-1697): the copies
 * with the same content and the copies of files that ctxpipe owns go to
 * the canonical path, through the write broker. The tip check queues it
 * when the tip that the knowledge plane projected has a hidden copy. The
 * plan reads the tree that the push lands on. The log holds counts only, no
 * file.
 */
export const workspaceCaseRepair = defineReplanningHostWriteWorkflow({
  name: "workspace-write-case-repair",
  kind: "case_repair",
  schema: z
    .object({
      orgId: z.string().min(1),
      workspaceId: z.string().min(1),
      jobId: z.string().min(1),
      revision: workspaceRevisionSchema,
    })
    .strict()
    .refine(
      (input) =>
        input.workspaceId === input.revision.workspaceId &&
        input.revision.access === "write-default",
      "A write-default revision for the matching workspace is required",
    ),
  change: async (input, { pack, read }) => {
    const plan = await planCaseRepair({ pack, read })
    getLogger().info("case_repair.plan", {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      ...plan.counts,
    })
    return plan.direct
  },
  subject: "ctxpipe - Keep one copy of files whose paths differ only in case",
})
