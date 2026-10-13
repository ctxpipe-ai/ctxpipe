/**
 * Error codes of the public MCP read tools (ADR-051 §5). A tool error is a
 * result with `isError: true` and `{ code, message, retryable }`, not a
 * JSON-RPC error, so the client agent can read it and change its call.
 */
export const MCP_TOOL_ERROR_CODES = [
  "org_not_found",
  "org_required",
  "workspace_not_found",
  "workspace_not_ready",
  "repository_not_found",
  "ambiguous_repository",
  "excluded_repository",
  "unknown_ref",
  "invalid_ref",
  "invalid_cursor",
  "stale_cursor",
  "invalid_argument",
  "response_too_large",
  "too_many_requests",
  "internal",
] as const

export type McpToolErrorCode = (typeof MCP_TOOL_ERROR_CODES)[number]

const RETRYABLE: ReadonlySet<McpToolErrorCode> = new Set([
  "workspace_not_ready",
  "too_many_requests",
  "internal",
])

export class McpToolError extends Error {
  readonly code: McpToolErrorCode
  readonly retryable: boolean

  constructor(code: McpToolErrorCode, message: string) {
    super(message)
    this.name = "McpToolError"
    this.code = code
    this.retryable = RETRYABLE.has(code)
  }
}

/**
 * Same text for an unknown org and an org outside the connection. For an
 * OAuth connection, `connectedAppsUrl` tells the user where to add an org to
 * the connection. The hint depends only on the kind of connection, not on
 * the org, so it does not tell whether the org exists.
 */
export function orgNotFound(
  slug: string,
  connectedAppsUrl: string | null = null,
): McpToolError {
  const hint = connectedAppsUrl
    ? ` If the user expects this org, they can add it to this connection in ctxpipe Connected apps: ${connectedAppsUrl}`
    : ""
  return new McpToolError(
    "org_not_found",
    `No org "${slug}" for this connection. Call list_workspaces.${hint}`,
  )
}

/** Same text for an unknown Workspace and a Workspace outside the connection. */
export function workspaceNotFound(org: string, slug: string): McpToolError {
  return new McpToolError(
    "workspace_not_found",
    `No Workspace "${slug}" in org "${org}" for this connection. Call list_workspaces.`,
  )
}

/** The call names no org, and the connection has no default org. */
export function orgRequired(
  message = "This call needs an org. Name it in the org argument; the server instructions list the orgs of this connection.",
): McpToolError {
  return new McpToolError("org_required", message)
}
