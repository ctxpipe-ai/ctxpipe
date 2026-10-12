import { z } from "zod"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * Retired with the folder-map marker comments (CTX-555). The
 * `workspace-write-ops-folder-list` workflow does this job now. OpenWorkflow
 * caches step outputs by step name, so the new steps use a new workflow name.
 * This name stays registered so that a run queued before the deploy completes
 * as skipped. Delete this file one release after that change ships.
 */
export const workspaceOpsFolderMapRetired = defineWorkflow(
  { name: "workspace-write-ops-folder-map", schema: z.looseObject({}) },
  async () => ({ status: "retired" as const }),
)
