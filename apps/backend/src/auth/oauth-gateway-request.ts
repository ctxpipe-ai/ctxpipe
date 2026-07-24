import type { Env } from "../config/env.js"
import { getLogger, log } from "../observability/logger.js"

/** Strip trailing slashes except preserve "/" for empty path normalization comparisons. */
function normalizeResourcePath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, "")
  return trimmed === "" ? "/" : trimmed
}

/**
 * When Better Auth accepts resource, rewrite client-sent URLs that differ only by query/hash
 * to the exact strings in oauthProvider.validAudiences (RFC8707 audience vs MCP URL query).
 */
export function canonicalResourceForValidAudiences(
  resourceUrl: URL,
  env: Env,
): string | null {
  let base: URL
  try {
    base = new URL(env.AUTH_BASE_URL)
  } catch {
    return null
  }
  if (resourceUrl.origin !== base.origin) return null

  const resourcePath = normalizeResourcePath(resourceUrl.pathname)
  const basePath = normalizeResourcePath(base.pathname)

  let mcpPath: string
  try {
    mcpPath = normalizeResourcePath(new URL("/mcp", env.AUTH_BASE_URL).pathname)
  } catch {
    return null
  }

  if (resourcePath === basePath) return env.AUTH_BASE_URL
  if (resourcePath === mcpPath) return `${env.AUTH_BASE_URL}/mcp`
  return null
}

type OAuthTokenRequestHints = {
  grant_type?: string
  client_id?: string
  /** URL-encoded token POST fields with secrets stripped (length/presence only). */
  redacted_request_body?: Record<string, unknown>
}

type PreparedBetterAuthRequest = {
  request: Request
  oauthTokenHints?: OAuthTokenRequestHints
}

/** OAuth/form keys whose values must never appear in logs. */
const SENSITIVE_OAUTH_PARAM_KEYS = new Set([
  "access_token",
  "client_secret",
  "code",
  "code_verifier",
  "id_token",
  "password",
  "refresh_token",
  "token",
])

/**
 * Turn application/x-www-form-urlencoded parameters into log-safe fields:
 * sensitive keys → `_present` / `_len`; others logged as-is.
 */
export function redactOAuthParams(
  params: URLSearchParams,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of params.entries()) {
    if (SENSITIVE_OAUTH_PARAM_KEYS.has(key)) {
      out[`${key}_present`] = value.length > 0
      out[`${key}_len`] = value.length
    } else {
      out[key] = value
    }
  }
  return out
}

function oauthTokenHintsFromParams(
  params: URLSearchParams,
): OAuthTokenRequestHints {
  return {
    grant_type: params.get("grant_type") ?? undefined,
    client_id: params.get("client_id") ?? undefined,
    redacted_request_body: redactOAuthParams(params),
  }
}

function rebuildPostRequest(original: Request, body: string): Request {
  const headers = new Headers(original.headers)
  headers.delete("content-length")
  return new Request(original.url, {
    method: original.method,
    headers,
    body,
  })
}

/**
 * Normalize RFC8707 `resource` on POST /oauth2/token (application/x-www-form-urlencoded).
 */
export async function prepareBetterAuthRequest(
  req: Request,
  env: Env,
): Promise<PreparedBetterAuthRequest> {
  const url = new URL(req.url)
  if (req.method !== "POST" || !url.pathname.endsWith("/oauth2/token")) {
    return { request: req }
  }

  const contentType = req.headers.get("content-type") ?? ""
  if (!contentType.includes("application/x-www-form-urlencoded")) {
    return { request: req }
  }

  let bodyText: string
  try {
    bodyText = await req.text()
  } catch {
    return { request: req }
  }

  const params = new URLSearchParams(bodyText)

  const resourceRaw = params.get("resource")
  if (!resourceRaw) {
    return {
      request: rebuildPostRequest(req, bodyText),
      oauthTokenHints: oauthTokenHintsFromParams(params),
    }
  }

  let canonical = resourceRaw
  try {
    const withoutHash = resourceRaw.split("#")[0] ?? resourceRaw
    const parsed = new URL(withoutHash)
    const matched = canonicalResourceForValidAudiences(parsed, env)
    if (matched) canonical = matched
  } catch {
    /* Better Auth validates */
  }

  if (canonical !== resourceRaw) {
    params.set("resource", canonical)
    return {
      request: rebuildPostRequest(req, params.toString()),
      oauthTokenHints: oauthTokenHintsFromParams(params),
    }
  }

  return {
    request: rebuildPostRequest(req, bodyText),
    oauthTokenHints: oauthTokenHintsFromParams(params),
  }
}

/**
 * Structured wide-event logging for OAuth JSON error bodies (e.g. 400 invalid_grant).
 * Call only when `response.status >= 400`. Does not consume the response body (uses clone).
 */
export async function logOAuthError(
  incomingReq: Request,
  outgoingRes: Response,
  hints?: OAuthTokenRequestHints,
): Promise<void> {
  const url = new URL(incomingReq.url)

  const contentType = outgoingRes.headers.get("content-type") ?? ""
  if (!contentType.includes("application/json")) return

  let payload: Record<string, unknown>
  try {
    payload = (await outgoingRes.clone().json()) as Record<string, unknown>
  } catch {
    return
  }

  const errorRaw = payload.error ?? payload.oauth_error
  const descRaw = payload.error_description ?? payload.oauth_error_description

  const queryRedacted = redactOAuthParams(url.searchParams)
  const oauth_request: {
    query?: Record<string, unknown>
    body?: Record<string, unknown>
  } = {}
  if (Object.keys(queryRedacted).length > 0) {
    oauth_request.query = queryRedacted
  }
  if (
    hints?.redacted_request_body &&
    Object.keys(hints.redacted_request_body).length > 0
  ) {
    oauth_request.body = hints.redacted_request_body
  }

  const wideEvent: Record<string, unknown> = {
    step: "oauth.endpoint_error",
    message: "Better Auth endpoint returned an error response",
    httpStatus: outgoingRes.status,
    path: url.pathname,
    grant_type: hints?.grant_type,
    client_id: hints?.client_id,
    oauth_error: typeof errorRaw === "string" ? errorRaw : undefined,
    oauth_error_description:
      typeof descRaw === "string" ? descRaw.slice(0, 500) : undefined,
  }
  if (Object.keys(oauth_request).length > 0) {
    wideEvent.oauth_request = oauth_request
  }

  try {
    getLogger().warn(wideEvent)
  } catch {
    log.warn(wideEvent)
  }
}
