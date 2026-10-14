import { otelDeploymentEnvironment } from "../../observability/otel.js"

/**
 * Shadow mode of ingestion v2 (ADR-052 phase 2). After the old pipeline
 * ingests a repository, the same SHA also goes through ingestion v2, which
 * publishes nothing. It runs for every org, but only in a deployment of the
 * allowlist: a preview (`pr-*`), `development`, or a local one (`local-*`).
 * Each other name, also `prod` or an unknown one, turns it off. The
 * committed switch for production stays off until the comparison (T20)
 * needs it.
 */
export function ingestionV2ShadowEnabled(): boolean {
  const inProduction = false
  return (
    inProduction ||
    /^(?:pr-[\w.-]+|development|local-[\w.-]+)$/.test(
      otelDeploymentEnvironment(),
    )
  )
}
