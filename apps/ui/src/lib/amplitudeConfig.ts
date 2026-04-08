/** Same-origin paths — avoid literal "amplitude" in URLs (ad blockers). */
export const AMPLITUDE_INGEST_PROXY_PREFIX = "/api/v1/t"
export const AMPLITUDE_RUNTIME_CONFIG_PATH = "/api/v1/c/s"

export type AmplitudeRegion = "us" | "eu"

export function parseAmplitudeRegion(
  raw: string | undefined,
): AmplitudeRegion {
  return raw?.trim().toLowerCase() === "eu" ? "eu" : "us"
}

/** Amplitude HTTP API host for domain proxy (ingest). */
export function amplitudeHttpApiOrigin(region: AmplitudeRegion): string {
  return region === "eu"
    ? "https://api.eu.amplitude.com"
    : "https://api2.amplitude.com"
}
