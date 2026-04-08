/** Same-origin ingest path — dot-route style (`/.amp/events`), like `/.auth/*` (ad blockers). */
export const AMPLITUDE_INGEST_PATH = "/.amp/events"

export const AMPLITUDE_RUNTIME_CONFIG_PATH = "/api/v1/c/s"

export type AmplitudeRegion = "us" | "eu"

export function parseAmplitudeRegion(raw: string | undefined): AmplitudeRegion {
  return raw?.trim().toLowerCase() === "eu" ? "eu" : "us"
}

/** Amplitude HTTP API origin for ingest proxy (server-side forward to `/2/httpapi`). */
export function amplitudeHttpApiOrigin(region: AmplitudeRegion): string {
  return region === "eu"
    ? "https://api.eu.amplitude.com"
    : "https://api2.amplitude.com"
}
