import type { MiddlewareHandler } from "hono"
import type { AppEnv } from "../app/env.js"

/** REST entity keys stored under Better Auth api-key `permissions` (see verify payload). */
export const ApiKeyEntities = {
  repositories: "repositories",
  conversations: "conversations",
  githubInstallation: "github_installation",
  connectors: "connectors",
  connectorsAtlassian: "connectors_atlassian",
  pendingAtlassianClaim: "pending_atlassian_claim",
  onboarding: "onboarding",
  knowledgeGraph: "knowledge_graph",
  me: "me",
  health: "health",
  mcp: "mcp",
} as const

export type ApiKeyEntity = (typeof ApiKeyEntities)[keyof typeof ApiKeyEntities]

function canReadEntity(
  permissions: Record<string, string[]> | null,
  entity: string,
): boolean {
  const actions = permissions?.[entity]
  if (!actions?.length) return false
  return actions.includes("read") || actions.includes("write")
}

function canWriteEntity(
  permissions: Record<string, string[]> | null,
  entity: string,
): boolean {
  return permissions?.[entity]?.includes("write") ?? false
}

/**
 * Path after `/api/v1/` (no leading slash), or empty string for `/…/api/v1`.
 */
export function pathAfterApiV1(pathname: string): string | null {
  const marker = "/api/v1/"
  const idx = pathname.indexOf(marker)
  if (idx === -1) return null
  return pathname.slice(idx + marker.length)
}

export function resolveRestEntityFromPath(
  pathAfterV1: string,
): ApiKeyEntity | null {
  const trimmed = pathAfterV1.replace(/\/+$/, "")
  const segments = trimmed.length === 0 ? [] : trimmed.split("/")

  if (segments.length === 0) return ApiKeyEntities.health

  const [a, b, c] = segments
  if (a === "repositories") return ApiKeyEntities.repositories
  if (a === "conversations") return ApiKeyEntities.conversations
  if (a === "github" && b === "installation")
    return ApiKeyEntities.githubInstallation
  if (a === "connectors") {
    if (b === "atlassian") {
      if (c === "pending-claim") return ApiKeyEntities.pendingAtlassianClaim
      return ApiKeyEntities.connectorsAtlassian
    }
    return ApiKeyEntities.connectors
  }
  if (a === "onboarding") return ApiKeyEntities.onboarding
  if (a === "knowledge-graph") return ApiKeyEntities.knowledgeGraph
  if (a === "me") return ApiKeyEntities.me
  return null
}

export function requestNeedsWrite(method: string): boolean {
  const m = method.toUpperCase()
  if (m === "GET" || m === "HEAD") return false
  if (m === "OPTIONS") return false
  return true
}

/** Enforces Better Auth `permissions` on api-key-authenticated REST requests. */
export const requireApiKeyScopes: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const apiKeyAuth = c.get("apiKeyAuth")
  if (!apiKeyAuth) return next()

  const pathTail = pathAfterApiV1(c.req.path)
  if (pathTail === null) return next()

  const entity = resolveRestEntityFromPath(pathTail)
  if (!entity) {
    return c.json(
      { error: "Forbidden", reason: "unknown_route_for_api_key" },
      403,
    )
  }

  const perms = apiKeyAuth.record.permissions
  const write = requestNeedsWrite(c.req.method)
  const ok = write
    ? canWriteEntity(perms, entity)
    : canReadEntity(perms, entity)

  if (!ok) {
    return c.json(
      { error: "Forbidden", reason: "insufficient_api_key_scope" },
      403,
    )
  }

  return next()
}

/** MCP Streamable HTTP — requires `mcp` → `read` (or `write`). */
export const requireMcpApiKeyScope: MiddlewareHandler<AppEnv> = async (
  c,
  next,
) => {
  const apiKeyAuth = c.get("apiKeyAuth")
  if (!apiKeyAuth) return next()

  const perms = apiKeyAuth.record.permissions
  if (!canReadEntity(perms, ApiKeyEntities.mcp)) {
    return c.json(
      { error: "Forbidden", reason: "insufficient_api_key_scope" },
      403,
    )
  }

  return next()
}
