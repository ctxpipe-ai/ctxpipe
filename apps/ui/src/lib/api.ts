import { hc } from "hono/client"
import type { registerV1Routes } from "../../../backend/src/routes/v1"

type V1Routes = ReturnType<typeof registerV1Routes>
export type ApiClient = ReturnType<typeof hc<V1Routes>>

function apiBaseUrl(): string {
  if (!import.meta.env.SSR) return window.location.origin
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "")
  }
  return "http://localhost:3000"
}

async function getRequestInit(): Promise<RequestInit> {
  // `import.meta.env.SSR` lets Vite drop the .server import from the client bundle.
  if (import.meta.env.SSR) {
    const { getServerApiHeaders } = await import("./api-headers.server")
    return {
      credentials: "include",
      headers: getServerApiHeaders(),
    }
  }
  return { credentials: "include" }
}

/** Isomorphic Hono client — forwards Cookie on SSR, credentials on the browser. */
export async function getApiClient(): Promise<ApiClient> {
  const init = await getRequestInit()
  return hc<V1Routes>(apiBaseUrl(), { init })
}

/**
 * Browser-relative client for client-only call sites.
 * Prefer {@link getApiClient} in shared queryFns / loaders.
 */
export const client = hc<V1Routes>("/", {
  init: { credentials: "include" },
})
