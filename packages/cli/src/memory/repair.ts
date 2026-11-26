import { existsSync } from "node:fs"
import { resolve } from "node:path"

import { CLIENT_LABELS } from "../constants.js"
import { applyOperations } from "../fs-operations.js"
import {
  buildMemoryArtifactOperations,
  createOperationContext,
} from "../mcp/mcp-operations.js"
import { buildMemoryHookOperations } from "./hooks.js"
import {
  buildMemoryUpgradeOperations,
  findLegacyMemoryHosts,
} from "./upgrade.js"

/**
 * CLI 0.2.0 wrote hooks and MCP entries that run `memory mcp` and
 * `memory hook`; 0.3.0 removed these commands. Hooks run the newest release,
 * so the old commands repair the repository in which they run: they apply the
 * `memory init` upgrade and write the capture hooks of each host that has a
 * 0.2.0 entry. A second run finds no 0.2.0 entry and changes nothing.
 *
 * The command runs from a hook or an MCP host. It always exits 0, writes
 * nothing to stdout (a host can parse it), and writes one line to stderr.
 */
export function runLegacyMemoryRepair(command: "mcp" | "hook"): void {
  const prefix = `ctxpipe: \`memory ${command}\` was removed in 0.3.0.`
  let line: string
  try {
    line = `${prefix} ${repair()}`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    line = `${prefix} The repair of the memory setup failed (${reason.split("\n")[0]}). Run \`npx ctxpipe memory init\`.`
  }
  process.stderr.write(`${line}\n`)
  process.exitCode = 0
}

function repair(): string {
  const context = createOperationContext()
  // Repair only a repository that has memory; never seed memory in another directory.
  if (!existsSync(resolve(context.cwd, ".ai", "memory"))) {
    return "This directory has no .ai/memory, so there is nothing to repair."
  }
  const hosts = findLegacyMemoryHosts(context)
  if (!hosts) return "This repository has no 0.2.0 memory entry to repair."

  // Write the new hooks first and remove the 0.2.0 entries last. If a write
  // fails, the 0.2.0 entries stay, and the next run tries the repair again.
  applyOperations([
    ...buildMemoryArtifactOperations({ context }),
    ...buildMemoryHookOperations({ clients: hosts, scope: "repo", context }),
    ...buildMemoryUpgradeOperations({ context }),
  ])
  const labels = hosts.map((host) => CLIENT_LABELS[host]).join(", ")
  return hosts.length > 0
    ? `Removed the 0.2.0 memory entries and wrote the capture hooks for ${labels}.`
    : "Removed the 0.2.0 memory entries."
}
