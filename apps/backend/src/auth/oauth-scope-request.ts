import { eq } from "drizzle-orm"

import { getSystemDb } from "../db/client.js"
import { oauthClients } from "../db/schema/auth.js"
import { MCP_READ_SCOPE, MCP_WRITE_SCOPE } from "./mcp-scopes.js"

async function authorizeScope(url: URL): Promise<string | null> {
  const requested = url.searchParams.get("scope")?.split(" ").filter(Boolean)
  if (requested?.length) {
    // ctxpipe offers no write scope now, but a client that registered before
    // can still list it. Ask for read in its place.
    if (!requested.includes(MCP_WRITE_SCOPE)) return null
    const capped = requested.filter((scope) => scope !== MCP_WRITE_SCOPE)
    if (!capped.includes(MCP_READ_SCOPE)) capped.unshift(MCP_READ_SCOPE)
    return capped.join(" ")
  }
  const clientId = url.searchParams.get("client_id")
  if (!clientId) return null
  const [client] = await getSystemDb()
    .select({
      scopes: oauthClients.scopes,
    })
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1)
  if (!client) return null

  const allowed = (scope: string) =>
    client.scopes === null || client.scopes.includes(scope)
  // No scope: ask for the read baseline, not every scope of the client, so
  // that one read-only consent covers the next authorization too.
  if (!allowed(MCP_READ_SCOPE)) return null
  return allowed("offline_access")
    ? `${MCP_READ_SCOPE} offline_access`
    : MCP_READ_SCOPE
}

/**
 * Apply the MCP scope rules to an OAuth request before Better Auth sees it.
 *
 * - `GET /oauth2/authorize` with no `scope` asks for `ctxpipe:read` (and
 *   `offline_access` when the client may have it).
 * - `GET /oauth2/authorize` that asks for `ctxpipe:write` asks for
 *   `ctxpipe:read` in its place. Better Auth then refuses a consent that adds
 *   `ctxpipe:write`, because the consent must stay inside the asked scopes.
 */
export async function applyMcpScopeRules(request: Request): Promise<Request> {
  const url = new URL(request.url)
  if (request.method === "GET" && url.pathname.endsWith("/oauth2/authorize")) {
    const scope = await authorizeScope(url)
    if (scope === null) return request
    url.searchParams.set("scope", scope)
    return new Request(url, request)
  }
  return request
}
