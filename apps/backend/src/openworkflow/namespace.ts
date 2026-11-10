import {
  deploymentEnvironment,
  isPreviewDeployment,
} from "../config/deployment-environment.js"

/**
 * Preserve the historical production namespace while ensuring a preview,
 * whose database is a copy of production, cannot replay the workflow rows
 * it copied. A preview copies the production variables too, so the
 * deployment name wins over `OPENWORKFLOW_NAMESPACE_ID`.
 */
export function openWorkflowNamespaceId(
  env: Record<string, string | undefined> = process.env,
): string {
  if (isPreviewDeployment(env)) return `preview-${deploymentEnvironment(env)}`

  const configured = env.OPENWORKFLOW_NAMESPACE_ID?.trim()
  if (configured) return configured

  return "default"
}
