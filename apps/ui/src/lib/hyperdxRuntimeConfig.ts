/**
 * Browser OTEL (`@hyperdx/browser`) — on when the UI server has an OTLP traces endpoint.
 * The browser always posts to `/.otel`. The server holds the collector URL and key
 * (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`).
 * Runtime config is read in the root route loader (SSR). No `VITE_PUBLIC_*`.
 */

export type HyperDxRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true
      /** `RAILWAY_ENVIRONMENT_NAME` when set (`production`, `pr-N`). Omitted rather than guessed. */
      environment?: string
    }

/** Reads UI server env. Use from API routes, server functions, or SSR loaders — not from the browser bundle. */
export function getHyperDxRuntimeConfig(): HyperDxRuntimeConfig {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) return { enabled: false }
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  return environment ? { enabled: true, environment } : { enabled: true }
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

export function resetRetainedHyperDxRuntimeConfigForTests(): void {
  retainedEnabledConfig = null
}
