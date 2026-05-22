export const DEFAULT_BASE_URL = "https://app.ctxpipe.ai"
export const AUTH_CLIENT_ID = "ctxpipe-cli"
export const DEVICE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code"

export const CLIENTS = ["codex", "claude", "cursor", "opencode", "vscode"] as const

export type Client = (typeof CLIENTS)[number]
export type Scope = "repo" | "user" | "both"

export const CLIENT_LABELS: Record<Client, string> = {
  codex: "Codex",
  claude: "Claude Code",
  cursor: "Cursor",
  opencode: "OpenCode",
  vscode: "VS Code / Copilot",
}

export const CLIENT_COMMANDS: Record<Client, string> = {
  codex: "codex",
  claude: "claude",
  cursor: "cursor",
  opencode: "opencode",
  vscode: "code",
}
