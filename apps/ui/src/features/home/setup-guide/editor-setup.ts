/**
 * The setup command for the step that connects the agents of the user.
 * The CLI uses the hosted origin when it gets no `--base-url`
 * (`DEFAULT_BASE_URL` in `packages/cli/src/constants.ts`). On each other
 * origin (self-host, previews, local dev), the command must name that origin.
 */
export function editorSetupCommand(origin: string): string {
  if (origin === "https://app.ctxpipe.ai") return "npx ctxpipe init"
  return `npx ctxpipe init --base-url ${origin}`
}

/** The MCP endpoint. It has no `?orgSlug=`, because ADR-051 ignores it. */
export function mcpServerUrl(origin: string): string {
  return `${origin}/mcp`
}
