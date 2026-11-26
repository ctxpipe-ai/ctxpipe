import { z } from "zod"

import { planGithubMirrorCleanup } from "../../domain/workspaces/github-mirror-cleanup.js"
import { workspaceRevisionSchema } from "../../domain/workspaces/revision.js"
import { getLogger } from "../../observability/logger.js"
import { defineReplanningHostWriteWorkflow } from "./workspace-replanning-host-write.js"

/**
 * The one-time cleanup of the GitHub pull request and issue mirrors of one
 * Workspace (CTX-1693): one direct host commit through the write broker.
 * Only an operator queues it (`src/scripts/cleanupGithubMirrors.ts --apply`).
 * The plan reads the tree that the push lands on, so the sources that keep a
 * mirror are the sources of that commit. The log holds counts only, no
 * repository and no file.
 */
export const workspaceGithubMirrorCleanup = defineReplanningHostWriteWorkflow({
  name: "workspace-write-github-mirror-cleanup",
  kind: "github_mirror_cleanup",
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
    const plan = await planGithubMirrorCleanup({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
      pack,
      read,
    })
    getLogger().info("github_mirror_cleanup.plan", {
      workspaceId: input.workspaceId,
      jobId: input.jobId,
      ...plan.counts,
    })
    return { files: plan.files, deletePaths: plan.deletePaths }
  },
  subject: "ctxpipe - Clean up the GitHub pull request and issue mirrors",
})
