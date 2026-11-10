/**
 * The name of this deployment: `production`, `pr-N` for a preview, or
 * `local-<name>`. The platform sets `DEPLOYMENT_ENVIRONMENT`. Railway sets
 * `RAILWAY_ENVIRONMENT_NAME`, which stays a fallback until the Railway
 * previews are gone. Undefined when neither is set (self-host, local dev).
 */
export function deploymentEnvironment(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return (
    env.DEPLOYMENT_ENVIRONMENT?.trim() ||
    env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    undefined
  )
}

/** True for a PR preview (`pr-N`). */
export function isPreviewDeployment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return /^pr-\d+$/.test(deploymentEnvironment(env) ?? "")
}
