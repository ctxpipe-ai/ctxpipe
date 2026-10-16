import { z } from "zod"
import { otelDeploymentEnvironment } from "../../observability/otel.js"
import {
  INGESTION_V2_PUBLISH_FORMAT,
  workspaceFormatAtLeast,
} from "../workspaces/workspace-format.js"

/**
 * Shadow mode of ingestion v2 (ADR-052 phase 2). After the old pipeline
 * ingests a repository, the same SHA also goes through ingestion v2, which
 * publishes nothing. It runs for every org, but only in a deployment of the
 * allowlist: a preview (`pr-*`), `development`, or a local one (`local-*`).
 * Each other name, also `prod` or an unknown one, turns it off, and so does
 * a deployment with no label: the label must be set, never the `development`
 * fallback. The committed switch for production stays off until the
 * comparison (T20) needs it.
 */
export function ingestionV2ShadowEnabled(): boolean {
  const inProduction = false
  // With no Railway name and no `deployment.environment` attribute, the
  // name is `production` here, which is not in the allowlist.
  const label = otelDeploymentEnvironment(undefined, "production")
  return (
    inProduction || /^(?:pr-[\w.-]+|development|local-[\w.-]+)$/.test(label)
  )
}

/**
 * The pipeline that publishes extracted knowledge to one Workspace (ADR-052
 * phase 4, G5). `legacy` is the old pipeline. `v2` is ingestion v2. The
 * Workspace format is the one switch: format 3 or more is `v2`, and a lower
 * or unknown format is `legacy`. No Workspace gets both. Each publish path
 * reads the format from the tree that it pushes on, not from the cache, so
 * a revert of the upgrade pull request takes the Workspace back to `legacy`.
 */
export const ingestionPublishPipelineSchema = z.enum(["legacy", "v2"])
export type IngestionPublishPipeline = z.infer<
  typeof ingestionPublishPipelineSchema
>

/** The publish pipeline of a Workspace at `format`. */
export function workspacePublishPipeline(
  format: number | null,
): IngestionPublishPipeline {
  return workspaceFormatAtLeast(format, INGESTION_V2_PUBLISH_FORMAT)
    ? "v2"
    : "legacy"
}

/**
 * A field that a run input or a write job payload held before the format
 * became the switch. A queued run that still holds it must parse. No code
 * reads it.
 */
export const retiredPublishPipelineField =
  ingestionPublishPipelineSchema.optional()

/**
 * The G5 gate: ingestion v2 publishes to a destination Workspace when the
 * format of THAT Workspace is 3 or more. A Workspace below 3, or one whose
 * format is not read yet (null), keeps the legacy path. The gate is per
 * destination, because one v2 run publishes to each Workspace that declares
 * the source. Read the format from the Workspace row (`formatVersion`).
 */
export function ingestionV2EnabledFor(workspace: {
  formatVersion: number | null | undefined
}): boolean {
  return workspaceFormatAtLeast(
    workspace.formatVersion ?? null,
    INGESTION_V2_PUBLISH_FORMAT,
  )
}
