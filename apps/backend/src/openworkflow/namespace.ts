/**
 * Preserve the historical production namespace while ensuring a duplicated
 * Railway PR environment cannot replay workflow rows copied from production.
 */
export function openWorkflowNamespaceId(
  env: Record<string, string | undefined> = process.env,
): string {
  const railwayEnvironment = env.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (railwayEnvironment && /^pr-\d+$/.test(railwayEnvironment)) {
    return `preview-${railwayEnvironment}`
  }

  const configured = env.OPENWORKFLOW_NAMESPACE_ID?.trim()
  if (configured) return configured

  return "default"
}
