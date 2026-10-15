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
