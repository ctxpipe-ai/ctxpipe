// Validates the Claude plugin (plugins/ctxpipe) and the marketplace
// (.claude-plugin/marketplace.json), installs the plugin from the marketplace
// into an empty Claude config directory, and checks that the installed plugin
// is enabled and points its MCP server at the hosted product.
//
// The Claude Code CLI is pinned in scripts/ci/claude-cli/package.json, which
// is outside the pnpm workspace so that its large binary stays out of every
// other install. The check installs it from that lockfile when it is missing.
// An install needs the network; a run of an installed CLI does not.
//
// Usage: node scripts/ci/check-claude-plugin.mjs

import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("../..", import.meta.url))
const config = mkdtempSync(join(tmpdir(), "claude-plugin-"))
const cliDir = join(root, "scripts/ci/claude-cli")
if (!existsSync(join(cliDir, "node_modules/.bin/claude"))) {
  const install = spawnSync(
    "pnpm",
    ["install", "--frozen-lockfile", "--dir", cliDir],
    { stdio: "inherit" },
  )
  if (install.status !== 0) throw new Error("The CLI install failed.")
}
const claude = (...args) => {
  const run = spawnSync(
    join(cliDir, "node_modules/.bin/claude"),
    args,
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      stdio: ["ignore", "pipe", "inherit"],
    },
  )
  if (run.error || run.status !== 0)
    throw new Error(
      `claude ${args.join(" ")} failed (${run.error?.message ?? `exit ${run.status}`})`,
    )
  process.stdout.write(run.stdout)
  return run.stdout
}

try {
  claude("plugin", "validate", "./plugins/ctxpipe", "--strict")
  claude("plugin", "validate", ".", "--strict")
  claude("plugin", "marketplace", "add", root, "--scope", "user")
  claude("plugin", "install", "ctxpipe@ctxpipe", "--scope", "user", "--yes")
  const plugins = JSON.parse(claude("plugin", "list", "--json"))
  const installed = plugins.some(
    (plugin) =>
      plugin.id === "ctxpipe@ctxpipe" &&
      plugin.enabled === true &&
      plugin.mcpServers?.ctxpipe?.url === "https://app.ctxpipe.ai/mcp",
  )
  if (!installed)
    throw new Error(
      "The plugin ctxpipe@ctxpipe is not installed and enabled with the MCP server https://app.ctxpipe.ai/mcp. Check plugins/ctxpipe/.mcp.json and .claude-plugin/marketplace.json.",
    )
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
} finally {
  rmSync(config, { recursive: true, force: true })
}
