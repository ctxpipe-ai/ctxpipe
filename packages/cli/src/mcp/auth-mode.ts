export const MCP_AUTH_MODES = ["oauth", "api-key"] as const

export type McpAuthMode = (typeof MCP_AUTH_MODES)[number]

export function validateAuthMode(auth: string): asserts auth is McpAuthMode {
  if (!MCP_AUTH_MODES.includes(auth as McpAuthMode)) {
    throw new Error("--auth must be one of: oauth, api-key")
  }
}

export function resolveMcpApiKey(opts: {
  auth?: string | null
  apiKey?: string | null
  env?: NodeJS.ProcessEnv
}): string | undefined {
  const auth = opts.auth?.trim() || "oauth"
  validateAuthMode(auth)
  if (auth !== "api-key") return undefined
  const fromEnv = (opts.env ?? process.env).CTXPIPE_API_KEY?.trim()
  const key = opts.apiKey?.trim() || fromEnv
  if (!key) {
    throw new Error(
      "Missing API key for --auth api-key. Pass --api-key or set CTXPIPE_API_KEY. Keys are written only to user-level client config.",
    )
  }
  return key
}

export const REPO_API_KEY_SKIP_DETAIL =
  "API keys must not land in committed files. Repo MCP config was not written. Use --scope user with --auth api-key to write an x-api-key header to user-level client config."
