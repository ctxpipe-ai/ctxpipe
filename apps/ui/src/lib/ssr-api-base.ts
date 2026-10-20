/**
 * Base URL for server-side fetches to the backend (auth + Hono API).
 * Browser code should use `window.location.origin` instead.
 *
 * Prefer runtime `AUTH_BASE_URL` (Railway / Compose) over bake-time
 * `VITE_PUBLIC_API_URL`, which defaults to localhost in the UI Dockerfile and
 * is unreachable from a separate UI container.
 */
export function ssrApiBaseUrl(): string {
  if (typeof process !== "undefined") {
    const runtime = process.env.AUTH_BASE_URL
    if (typeof runtime === "string" && runtime.length > 0) {
      return runtime.replace(/\/$/, "")
    }
  }
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "")
  }
  return "http://localhost:3000"
}
