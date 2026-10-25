import { eq } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { oauthClients } from "../db/schema/auth.js"
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "./mcp-scopes.js"

function withoutWrite(scopes: readonly string[]): string[] {
  return scopes.filter((scope) => scope !== MCP_WRITE_SCOPE)
}

async function authorizeScope(url: URL): Promise<string | null> {
  const clientId = url.searchParams.get("client_id")
  if (!clientId) return null
  const [client] = await getSystemDb()
    .select({
      scopes: oauthClients.scopes,
      skipConsent: oauthClients.skipConsent,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1)
  if (!client) return null

  const allowed = (scope: string) =>
    client.scopes === null || client.scopes.includes(scope)
  const requested = url.searchParams.get("scope")?.split(" ").filter(Boolean)
  if (requested?.length) {
    // Write needs a human tick at consent; a client that skips consent never gets it.
    if (!client.skipConsent || !requested.includes(MCP_WRITE_SCOPE)) return null
    const capped = withoutWrite(requested)
    return capped.length > 0 ? capped.join(" ") : MCP_READ_SCOPE
  }
  // No scope: ask for the read baseline, not every scope of the client, so
  // that one read-only consent covers the next authorization too.
  if (!allowed(MCP_READ_SCOPE)) return null
  return allowed("offline_access")
    ? `${MCP_READ_SCOPE} offline_access`
    : MCP_READ_SCOPE
}

async function consentBody(request: Request): Promise<string | null> {
  if (
    !(request.headers.get("content-type") ?? "").includes("application/json")
  ) {
    return null
  }
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as Record<string, unknown> | null
  if (!body || body.accept !== true) return null
  if (typeof body.scope === "string" && body.scope.trim().length > 0) {
    return null
  }
  const query =
    typeof body.oauth_query === "string"
      ? new URLSearchParams(body.oauth_query)
      : null
  const requested = query?.get("scope")?.split(" ").filter(Boolean) ?? []
  // A consent with no scope list grants what was asked for, except write:
  // write needs the explicit tick. An empty list makes Better Auth refuse.
  return JSON.stringify({ ...body, scope: withoutWrite(requested).join(" ") })
}

/**
 * Apply the MCP scope rules to an OAuth request before Better Auth sees it.
 *
 * - `GET /oauth2/authorize` with no `scope` asks for `ctxpipe:read` (and
 *   `offline_access` when the client may have it).
 * - `GET /oauth2/authorize` from a client that skips consent drops
 *   `ctxpipe:write`.
 * - `POST /oauth2/consent` that accepts with no `scope` list leaves out
 *   `ctxpipe:write`.
 */
export async function applyMcpScopeRules(request: Request): Promise<Request> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname.endsWith("/oauth2/authorize")) {
    const scope = await authorizeScope(url)
    if (scope === null) return request
    url.searchParams.set("scope", scope)
    return new Request(url, request)
  }
  if (request.method === "POST" && url.pathname.endsWith("/oauth2/consent")) {
    const body = await consentBody(request)
    if (body === null) return request
    return new Request(request, { body })
  }
  return request
}
