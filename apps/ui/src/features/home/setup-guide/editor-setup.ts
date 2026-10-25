import HyperDX from "@hyperdx/browser"

import { recordHyperDxActionError } from "@/lib/hyperdxBrowser"

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

/** The user copied the MCP setup command. Records the event, not the value. */
export function recordMcpConfigCopied(target: "setup_command") {
  HyperDX.addAction("mcp_config_copy", { target })
}

/** The browser refused the copy of the MCP setup command. */
export function recordMcpConfigCopyFailed(target: "setup_command") {
  recordHyperDxActionError("mcp_config_copy", { target })
}
