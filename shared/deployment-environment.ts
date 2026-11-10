// The backend, codesearch and the UI server import this file. Delete the
// Railway fallback here when the Railway previews are gone.

const PREVIEW = /^pr-\d+$/

/**
 * The name of a hosted deployment: `production`, or `pr-N` for a preview.
 * The platform sets `DEPLOYMENT_ENVIRONMENT`. Railway sets
 * `RAILWAY_ENVIRONMENT_NAME`, the fallback while Railway previews exist. A
 * Railway preview copies the production variables, `DEPLOYMENT_ENVIRONMENT`
 * included, so its own `pr-N` name wins. Undefined when neither is set
 * (self-host, local dev).
 */
export function deploymentEnvironment(
  env: Record<string, string | undefined>,
): string | undefined {
  const railway = env.RAILWAY_ENVIRONMENT_NAME?.trim()
  if (railway && PREVIEW.test(railway)) return railway
  return env.DEPLOYMENT_ENVIRONMENT?.trim() || railway || undefined
}

/** True for a PR preview (`pr-N`). */
export function isPreviewDeployment(
  env: Record<string, string | undefined>,
): boolean {
  return PREVIEW.test(deploymentEnvironment(env) ?? "")
}
