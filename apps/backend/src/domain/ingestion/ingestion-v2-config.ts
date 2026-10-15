import { otelDeploymentEnvironment } from "../../observability/otel.js"

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
 * This is committed config, not an env var: change the default of
 * `committed`. To roll back within one release,
 * set it to `legacy` again: the old pipeline publishes again and writes
 * `generated_by: ctxpipe` on each file it changes. When it goes back to `v2`,
 * the migration moves those files again.
 */
export type IngestionPublishPipeline = "legacy" | "v2"

export function ingestionPublishPipeline(
  committed: IngestionPublishPipeline = "legacy",
): IngestionPublishPipeline {
  // Ingestion v2 cannot publish until T21 (publish from the ref) is merged.
  // Until then `v2` stops each publish, so each caller fails loudly instead.
  // T21 removes this check.
  if (committed === "v2")
    throw new Error(
      "The publish pipeline is v2, but ingestion v2 cannot publish yet (T21)",
    )
  return committed
}
