import { z } from "zod"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * Retired with upgrade step 1 (ADR-053, CTX-743). This workflow pushed the
 * knowledge export straight to the default branch of a Workspace
 * repository. The export is now part of the upgrade pull request that an
 * owner or admin opens. Workers retry runs of an unregistered workflow
 * forever, so this name ends a run that an older build queued, with no
 * write. Delete this stub one minor release after the upgrade ships.
 */
export const workspaceMigrationExportRetired = defineWorkflow(
  { name: "workspace-write-migration-export", schema: z.looseObject({}) },
  async () => ({ status: "retired" as const }),
)
