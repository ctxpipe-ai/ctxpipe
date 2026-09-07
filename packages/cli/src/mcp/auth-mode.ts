export const MCP_AUTH_MODES = ["oauth", "api-key"] as const

export type McpAuthMode = (typeof MCP_AUTH_MODES)[number]

export type McpAuthConfig = { mode: "oauth" } | { mode: "api-key" }

export function validateAuthMode(auth: string): asserts auth is McpAuthMode {
  if (!MCP_AUTH_MODES.includes(auth as McpAuthMode)) {
    throw new Error("--auth must be one of: oauth, api-key")
  }
}

export function resolveMcpAuth(opts: { auth?: string | null }): McpAuthConfig {
  const auth = opts.auth?.trim() || "oauth"
  validateAuthMode(auth)
  return { mode: auth }
}
