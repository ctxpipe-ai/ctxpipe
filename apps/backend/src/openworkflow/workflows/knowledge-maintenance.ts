import { z } from "zod"

import { getLogger } from "../../observability/logger.js"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/**
 * The maintenance job of the knowledge plane (ADR-067 decision 9). The
 * projection writer queues one run for each tip that it applies. The job
 * that finds and fixes the `deleted`, `missing` and `failed` documents
 * comes in a later issue. Until then, a run only logs its input.
 */
export const knowledgeMaintenance = defineWorkflow(
  {
    name: "knowledge-maintenance",
    schema: z
      .object({
        orgId: z.string().min(1),
        workspaceId: z.string().min(1),
        /** The tip that the writer applied. */
        sha: z.string().min(1),
      })
      .strict(),
    logFields: (input) => ({
      orgId: input.orgId,
      workspaceId: input.workspaceId,
    }),
  },
  async ({ input }) => {
    getLogger().set({
      step: "knowledge-maintenance.queued",
      knowledgeMaintenance: { sha: input.sha },
    })
  },
)
