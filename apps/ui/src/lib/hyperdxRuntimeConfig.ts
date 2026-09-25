/**
 * Browser OTEL (`@hyperdx/browser`) — opt-in when the UI server has an OTLP traces endpoint.
 * Runtime config is read in the root route loader (SSR). No `VITE_PUBLIC_*`.
 */

export type HyperDxRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true
      url: string
      environment: string
      apiKey?: string
    }

/** Reads UI server env. Use from API routes, server functions, or SSR loaders — not from the browser bundle. */
export function getHyperDxRuntimeConfig(): HyperDxRuntimeConfig {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) return { enabled: false }

  const publicUrl = process.env.OTEL_BROWSER_OTLP_URL?.trim()
  const apiKey = process.env.OTEL_BROWSER_API_KEY?.trim()
  const environment =
    process.env.RAILWAY_ENVIRONMENT_NAME?.trim() ||
    process.env.NODE_ENV ||
    "development"

  return {
    enabled: true,
    url: publicUrl || "/.otel",
    environment,
    ...(apiKey ? { apiKey } : {}),
  }
}

let retainedEnabledConfig: Extract<
  HyperDxRuntimeConfig,
  { enabled: true }
> | null = null

/**
 * Client navigations can re-run the root loader without server env and produce
 * `{ enabled: false }`. Keep the SSR-enabled config for the rest of the page.
 */
export function retainServerHyperDxConfig(
  config: HyperDxRuntimeConfig,
): HyperDxRuntimeConfig {
  if (config.enabled) retainedEnabledConfig = config
  return retainedEnabledConfig ?? config
}
