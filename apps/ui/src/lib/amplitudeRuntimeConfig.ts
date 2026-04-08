import {
  type AmplitudeRegion,
  parseAmplitudeRegion,
} from "@/lib/amplitudeConfig"

/**
 * Amplitude browser analytics — **opt-in via `AMPLITUDE_API_KEY` on the UI server**.
 *
 * When the key is **unset**, `enabled: false` and the app **does not** initialize the Browser SDK
 * or send events (default). Same rule as backend: no telemetry without an explicit key.
 */

export type AmplitudeRuntimeConfig =
  | { enabled: false }
  | { enabled: true; apiKey: string; region: AmplitudeRegion }

/** Reads UI server env. Use from API routes, server functions, or SSR loaders — not from the browser bundle. */
export function getAmplitudeRuntimeConfig(): AmplitudeRuntimeConfig {
  const apiKey = process.env.AMPLITUDE_API_KEY?.trim() ?? ""
  if (!apiKey) return { enabled: false }
  return {
    enabled: true,
    apiKey,
    region: parseAmplitudeRegion(process.env.AMPLITUDE_REGION),
  }
}
