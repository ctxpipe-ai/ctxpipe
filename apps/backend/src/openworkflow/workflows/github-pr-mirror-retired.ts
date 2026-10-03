import { z } from "zod"
import { defineWorkflow } from "../defineObservedWorkflow.js"

/*
 * Retired with the per-connection pull-request mirror binding (ADR-031,
 * 2026-10-03). Workers retry runs of an unregistered workflow forever, so
 * these names complete any run queued before the deploy as skipped.
 * Delete this file one release after that change ships.
 */

const anyInput = z.looseObject({})

export const githubEnsurePrMirrorRetired = defineWorkflow(
  { name: "github-ensure-pr-mirror", schema: anyInput },
  async () => ({ status: "retired" as const }),
)

export const githubSyncContentRetired = defineWorkflow(
  { name: "github-sync-content", schema: anyInput },
  async () => ({ status: "retired" as const }),
)
