import { z } from "zod"

import { otelDeploymentEnvironment } from "../../observability/otel.js"
import {
  CODE_FORMAT,
  INGESTION_V2_PUBLISH_FORMAT,
  workspaceFormatAtLeast,
} from "../workspaces/workspace-format.js"

/**
 * Shadow mode of ingestion v2 (ADR-052 phase 2). After a repository is
 * indexed, the same SHA also goes through ingestion v2, which publishes
 * nothing. It runs for every org, but only in a deployment of the
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
 * The ingestion that writes extracted knowledge to one Workspace (ADR-052
 * phase 4, G5). The Workspace format is the one switch:
 *
 * - `v2`: a format from 3 to {@link CODE_FORMAT}. Ingestion v2 publishes.
 * - `none`: a format below 3, a format that is not read yet (null), a format
 *   file that is not valid (-1), or a format above {@link CODE_FORMAT}. No
 *   ingestion writes to the Workspace. Below 3 its knowledge stays as it is
 *   until the upgrade merges. The other cases are read-only (ADR-053).
 *
 * Each publish path reads the format from the tree that it pushes on, not
 * from the cache, so a revert of the upgrade pull request stops ingestion.
 */
type IngestionPublishPipeline = "v2" | "none"

/** The ingestion that writes to a Workspace at `format`. */
export function workspacePublishPipeline(
  format: number | null,
): IngestionPublishPipeline {
  return workspaceFormatAtLeast(format, INGESTION_V2_PUBLISH_FORMAT) &&
    format !== null &&
    format <= CODE_FORMAT
    ? "v2"
    : "none"
}

/**
 * A field that a run input or a write job payload held before the format
 * became the switch. A queued run that still holds it must parse. No code
 * reads it.
 */
export const retiredPublishPipelineField = z.enum(["legacy", "v2"]).optional()

/**
 * The G5 gate: ingestion v2 publishes to a destination Workspace when
 * {@link workspacePublishPipeline} of THAT Workspace is `v2`. The gate is per
 * destination, because one v2 run publishes to each Workspace that declares
 * the source. Read the format from the Workspace row (`formatVersion`).
 */
export function ingestionV2EnabledFor(workspace: {
  formatVersion: number | null | undefined
}): boolean {
  return workspacePublishPipeline(workspace.formatVersion ?? null) === "v2"
}
