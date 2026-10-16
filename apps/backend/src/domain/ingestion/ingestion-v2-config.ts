import { z } from "zod"
import { otelDeploymentEnvironment } from "../../observability/otel.js"
import { INGESTION_V2_PUBLISH_FORMAT } from "../workspaces/workspace-format.js"

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
 * The pipeline that publishes extracted knowledge to Workspaces (ADR-052
 * phase 4). `legacy` is the old pipeline. `v2` is ingestion v2: hydrate then
 * moves the old extracted files to ingestion v2 ownership
 * (`ownership_migration`), and the old pipeline stops its publish.
 *
 * This is committed config, not an env var: change `committed` below. To
 * roll back within one release, set it to `legacy` again: the old pipeline
 * publishes again and writes `generated_by: ctxpipe` on each file it
 * changes. When it goes back to `v2`, the migration moves those files again.
 */
export const ingestionPublishPipelineSchema = z.enum(["legacy", "v2"])
export type IngestionPublishPipeline = z.infer<
  typeof ingestionPublishPipelineSchema
>

/**
 * A trigger reads the committed value and puts it in the run input of the
 * workflow (and in the write job payload). Each step that checks the switch
 * reads the input. The push step also compares the input with the committed
 * value at push time: a job that was queued before a switch stops
 * (`publishPipelineStopped`).
 */

export function ingestionPublishPipeline(): IngestionPublishPipeline {
  return "legacy"
}

/**
 * True when a publish job must not push: the pipeline of the job (`legacy`
 * for an old extract ingest, `v2` for an ingestion v2 publish), the
 * pipeline when the job was queued, and the committed value now must agree.
 */
export function publishPipelineStopped(input: {
  job: IngestionPublishPipeline
  queued: IngestionPublishPipeline
  committed: IngestionPublishPipeline
}): boolean {
  return input.queued !== input.job || input.committed !== input.job
}

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
  return (
    typeof workspace.formatVersion === "number" &&
    workspace.formatVersion >= INGESTION_V2_PUBLISH_FORMAT
  )
}
