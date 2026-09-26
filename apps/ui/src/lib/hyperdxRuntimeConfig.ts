import { createIsomorphicFn } from "@tanstack/react-start"
import { authClient, getSession } from "@/lib/auth-client"
import {
  type HyperDxOrgRef,
  type HyperDxSessionIdentity,
  hyperdxIdentity,
  isHyperDxSignOutPath,
} from "@/lib/hyperdxAttributes"

/**
 * Browser OTEL (`@hyperdx/browser`) — on when the UI server has an OTLP traces endpoint.
 * The browser always posts to `/.otel`. The server holds the collector URL and key.
 * The root loader reads this during SSR. Client navigations keep that result.
 */

export type HyperDxRuntimeConfig = {
  enabled: boolean
}

export type HyperDxDocumentContext = {
  config: HyperDxRuntimeConfig
  identity: HyperDxSessionIdentity | null
}

/** Reads UI server env. Use from the document loader — not from the browser bundle. */
export function getHyperDxRuntimeConfig(): HyperDxRuntimeConfig {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  return { enabled: Boolean(traces) }
}

/**
 * Session for the document that boots the SDK. The cookie is the browser's;
 * Better Auth returns the session, and we keep only ids and the org slug.
 * The UI server's Host is the proxy target, so Better Auth is called on the
 * forwarded public origin.
 */
export async function readHyperDxDocumentIdentity(
  request: Request,
  pathname: string,
): Promise<HyperDxSessionIdentity | null> {
  if (isHyperDxSignOutPath(pathname)) return null
  const cookie = request.headers.get("cookie")
  if (!cookie) return null
  const baseURL = documentAuthBaseUrl(request)
  if (baseURL === null) return null
  const fetchOptions = {
    headers: { cookie },
    ...(baseURL ? { baseURL } : {}),
    signal: AbortSignal.timeout(1_000),
  }
  try {
    const [sessionResult, orgResult] = await Promise.all([
      getSession({ fetchOptions }),
      authClient.organization.list({ fetchOptions }),
    ])
    const listed = orgResult.data
    const organizations: HyperDxOrgRef[] = Array.isArray(listed)
      ? listed.flatMap((org) =>
          org.id && org.slug ? [{ id: org.id, slug: org.slug }] : [],
        )
      : []
    return hyperdxIdentity(sessionResult.data, organizations, pathname)
  } catch {
    return null
  }
}

/**
 * `undefined` when the request has no forwarded host (use the auth client base URL).
 * `null` when the forwarded host or proto is not a plain hostname / http(s), so a
 * direct caller cannot point the identity read at an arbitrary URL path.
 */
function documentAuthBaseUrl(request: Request): string | null | undefined {
  const host = request.headers.get("x-forwarded-host")?.split(",")[0]?.trim()
  if (!host) return undefined
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return null
  const proto =
    request.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || "https"
  if (proto !== "https" && proto !== "http") return null
  return `${proto}://${host}/.auth/api/v1/auth`
}

/** SSR only. On the client this is replaced with a function that returns undefined. */
export const getHyperDxDocumentContext = createIsomorphicFn().server(
  async (pathname: string): Promise<HyperDxDocumentContext> => {
    const { getRequest } = await import("@tanstack/react-start/server")
    const config = getHyperDxRuntimeConfig()
    try {
      const identity = await readHyperDxDocumentIdentity(
        getRequest(),
        pathname || "/",
      )
      return { config, identity }
    } catch {
      return { config, identity: null }
    }
  },
)
