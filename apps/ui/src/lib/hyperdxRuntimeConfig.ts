import { createServerFn } from "@tanstack/react-start"
import {
  type HyperDxOrgRef,
  type HyperDxSessionIdentity,
  isHyperDxAuthPath,
  isHyperDxSignOutPath,
  orgSlugFromPathname,
  resolveHyperDxTeam,
} from "@/lib/hyperdxAttributes"

/**
 * Browser OTEL (`@hyperdx/browser`) — on when the UI server has an OTLP traces endpoint.
 * The browser always posts to `/.otel`. The server holds the collector URL and key
 * (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` / `OTEL_EXPORTER_OTLP_HEADERS`).
 * The root loader reads this through `getHyperDxDocumentContext` (a server function),
 * so client navigations do not re-read `process.env`.
 */

export type HyperDxRuntimeConfig =
  | { enabled: false }
  | {
      enabled: true
      /** `RAILWAY_ENVIRONMENT_NAME` when set (`production`, `pr-N`). Omitted rather than guessed. */
      environment?: string
    }

export type HyperDxDocumentContext = {
  config: HyperDxRuntimeConfig
  identity: HyperDxSessionIdentity | null
}

/** Reads UI server env. Use from API routes, server functions, or SSR loaders — not from the browser bundle. */
export function getHyperDxRuntimeConfig(): HyperDxRuntimeConfig {
  const traces = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  if (!traces) return { enabled: false }
  const environment = process.env.RAILWAY_ENVIRONMENT_NAME?.trim()
  return environment ? { enabled: true, environment } : { enabled: true }
}

const AUTH_PREFIX = "/.auth/api/v1/auth"

function browserAuthOrigin(request: Request): string | null {
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim()
  if (forwardedHost) {
    const protoHeader = request.headers
      .get("x-forwarded-proto")
      ?.split(",")[0]
      ?.trim()
      .toLowerCase()
    const proto = protoHeader === "https" ? "https" : "http"
    return `${proto}://${forwardedHost}`
  }
  const fromEnv = import.meta.env.VITE_PUBLIC_API_URL
  if (typeof fromEnv === "string" && fromEnv.length > 0) {
    return fromEnv.replace(/\/$/, "")
  }
  try {
    return new URL(request.url).origin
  } catch {
    return null
  }
}

function readNestedString(body: unknown, parent: string, key: string): string {
  if (!body || typeof body !== "object") return ""
  const child = (body as Record<string, unknown>)[parent]
  if (!child || typeof child !== "object") return ""
  const value = (child as Record<string, unknown>)[key]
  return typeof value === "string" ? value : ""
}

function readOrgList(body: unknown): HyperDxOrgRef[] {
  if (!Array.isArray(body)) return []
  const orgs: HyperDxOrgRef[] = []
  for (const item of body) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    const id = record.id
    const slug = record.slug
    if (typeof id !== "string" || typeof slug !== "string" || !id || !slug) {
      continue
    }
    orgs.push({ id, slug })
  }
  return orgs
}

/**
 * Session for the document that boots the SDK. The cookie is the browser's;
 * the UI server asks Better Auth and keeps only ids and the org slug.
 */
export async function readHyperDxDocumentIdentity(
  request: Request,
  pathname: string,
): Promise<HyperDxSessionIdentity | null> {
  if (isHyperDxSignOutPath(pathname)) return null
  const cookie = request.headers.get("cookie")
  if (!cookie) return null
  const origin = browserAuthOrigin(request)
  if (!origin) return null
  const headers = { cookie, accept: "application/json" }
  const signal = AbortSignal.timeout(1_000)
  const [sessionRes, orgRes] = await Promise.all([
    fetch(`${origin}${AUTH_PREFIX}/get-session`, { headers, signal }),
    fetch(`${origin}${AUTH_PREFIX}/organization/list`, { headers, signal }),
  ])
  if (!sessionRes.ok) return null
  const sessionBody: unknown = await sessionRes.json()
  const userId = readNestedString(sessionBody, "user", "id")
  if (!userId) return null
  if (isHyperDxAuthPath(pathname)) {
    return { userId, teamId: "", teamName: "" }
  }
  const organizations = orgRes.ok ? readOrgList(await orgRes.json()) : []
  const team = resolveHyperDxTeam({
    orgSlugFromRoute: orgSlugFromPathname(pathname),
    organizations,
    activeOrganizationId: readNestedString(
      sessionBody,
      "session",
      "activeOrganizationId",
    ),
  })
  return { userId, teamId: team.teamId, teamName: team.teamName }
}

export async function loadHyperDxDocumentContext(
  request: Request,
  pathname: string,
): Promise<HyperDxDocumentContext> {
  const config = getHyperDxRuntimeConfig()
  // Client navigations call this server function as `fetch` (`sec-fetch-dest: empty`).
  // The session hook updates attributes after that. The document request is what
  // stamps identity before the SDK's first spans.
  if (request.headers.get("sec-fetch-dest") === "empty") {
    return { config, identity: null }
  }
  try {
    const identity = await readHyperDxDocumentIdentity(request, pathname)
    return { config, identity }
  } catch {
    return { config, identity: null }
  }
}

function pathnameFromServerFnData(data: unknown): string {
  if (!data || typeof data !== "object" || !("pathname" in data)) return "/"
  const pathname = (data as { pathname?: unknown }).pathname
  return typeof pathname === "string" && pathname.length > 0 ? pathname : "/"
}

export const getHyperDxDocumentContext = createServerFn({ method: "GET" })
  .inputValidator((data: unknown) => ({
    pathname: pathnameFromServerFnData(data),
  }))
  .handler(async ({ data }) => {
    const { getRequest } = await import("@tanstack/react-start/server")
    return loadHyperDxDocumentContext(getRequest(), data.pathname)
  })
