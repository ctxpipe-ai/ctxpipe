export const MCP_AUTH_MODES = ["oauth", "api-key"] as const

export type McpAuthMode = (typeof MCP_AUTH_MODES)[number]

export type McpAuthConfig =
  | { mode: "oauth" }
  | { mode: "api-key"; placement: "literal"; apiKey: string }
  | { mode: "api-key"; placement: "env"; envVariable: string }

const ENV_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateAuthMode(auth: string): asserts auth is McpAuthMode {
  if (!MCP_AUTH_MODES.includes(auth as McpAuthMode)) {
    throw new Error("--auth must be one of: oauth, api-key")
  }
}

export function validateEnvVariableName(name: string): void {
  if (!ENV_VARIABLE_NAME.test(name)) {
    throw new Error(
      "--api-key-env-variable must be a valid environment variable name (letters, digits, and underscore; cannot start with a digit).",
    )
  }
}

export function resolveMcpAuth(opts: {
  auth?: string | null
  apiKey?: string | null
  apiKeyEnvVariable?: string | null
  env?: NodeJS.ProcessEnv
}): McpAuthConfig {
  const apiKey = opts.apiKey?.trim() || undefined
  const apiKeyEnvVariable = opts.apiKeyEnvVariable?.trim() || undefined
  if (apiKey && apiKeyEnvVariable) {
    throw new Error("Use either --api-key or --api-key-env-variable, not both.")
  }

  const impliedApiKey = Boolean(apiKey || apiKeyEnvVariable)
  const auth = opts.auth?.trim() || (impliedApiKey ? "api-key" : "oauth")
  validateAuthMode(auth)
  if (auth === "oauth") {
    if (impliedApiKey) {
      throw new Error(
        "Cannot combine --auth oauth with --api-key or --api-key-env-variable",
      )
    }
    return { mode: "oauth" }
  }

  if (apiKeyEnvVariable) {
    validateEnvVariableName(apiKeyEnvVariable)
    return {
      mode: "api-key",
      placement: "env",
      envVariable: apiKeyEnvVariable,
    }
  }

  const fromEnv = (opts.env ?? process.env).CTXPIPE_API_KEY?.trim()
  const key = apiKey || fromEnv
  if (!key) {
    throw new Error(
      "Missing API key for --auth api-key. Pass --api-key <key> to write a user-scope secret, --api-key-env-variable <name> to write an environment-variable reference, or set CTXPIPE_API_KEY for a user-scope literal key.",
    )
  }
  return { mode: "api-key", placement: "literal", apiKey: key }
}

export const REPO_API_KEY_SKIP_DETAIL =
  "API keys must not land in committed files. Repo MCP config was not written. Use --scope user with --api-key to write an x-api-key header to user-level client config, or --api-key-env-variable to write an environment-variable reference in repo or user config."
