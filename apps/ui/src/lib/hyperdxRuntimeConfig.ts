import { createIsomorphicFn } from "@tanstack/react-start"

import { authClient, getSession } from "@/lib/auth-client"
import {
  type HyperDxOrgRef,
  type HyperDxSessionIdentity,
  hyperdxIdentity,
  isHyperDxSignOutPath,
} from "@/lib/hyperdxAttributes"
import { ssrApiBaseUrl } from "@/lib/ssr-api-base"

/**
 * Browser OTEL (`@hyperdx/browser`) — on when the UI server has an OTLP traces endpoint.
 * The browser always posts to `/.otel`. The server holds the collector URL and key.
 * The root loader reads this during SSR. Client navigations keep that result.
 */

export type HyperDxRuntimeConfig = {
  enabled: boolean
}

type HyperDxDocumentContext = {
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
 * The call goes to the server-render API base, as the route loaders do.
 */
export async function readHyperDxDocumentIdentity(
  request: Request,
  pathname: string,
): Promise<HyperDxSessionIdentity | null> {
  if (isHyperDxSignOutPath(pathname)) return null
  const cookie = request.headers.get("cookie")
  if (!cookie) return null
  const fetchOptions = {
    headers: { cookie },
    baseURL: `${ssrApiBaseUrl()}/.auth/api/v1/auth`,
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
