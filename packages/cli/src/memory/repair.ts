import { existsSync, realpathSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

import type { Client } from "../constants.js"
import { CLIENT_LABELS } from "../constants.js"
import { applyOperations } from "../fs-operations.js"
import {
  buildMemoryArtifactOperations,
  createOperationContext,
} from "../mcp/mcp-operations.js"
import { extractWorkspaceCwd, readStdinJson } from "./capture.js"
import { hasCaptureHook } from "./harness.js"
import { buildMemoryHookOperations } from "./hooks.js"
import {
  buildMemoryUpgradeOperations,
  findLegacyMemoryEntries,
} from "./upgrade.js"

/**
 * CLI 0.2.0 wrote hooks and MCP entries that run `memory mcp` and
 * `memory hook`; 0.3.0 removed these commands. Hooks run the newest release,
 * so the old commands repair the repository in which they run: they write the
 * capture hooks of each host that has a 0.2.0 entry, and apply the
 * `memory init` upgrade to the files of the repository. A second run changes
 * nothing.
 *
 * The repair changes no file in the home directory. A 0.2.0 entry there runs
 * in each repository of the user, so it stays as the repair trigger of the
 * other repositories. `memory init` removes it.
 *
 * The command runs from a hook or an MCP host. It always exits 0, writes
 * nothing to stdout (a host can parse it), and writes one line to stderr.
 */
export async function runLegacyMemoryRepair(
  command: "mcp" | "hook",
): Promise<void> {
  const prefix = `ctxpipe: \`memory ${command}\` was removed in 0.3.0.`
  let line: string
  try {
    line = `${prefix} ${repair(await sessionCwd(command))}`
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    line = `${prefix} The repair of the memory setup failed (${reason.split("\n")[0]}). Run \`npx ctxpipe memory init\`.`
  }
  process.stderr.write(`${line}\n`)
}

/**
 * A hook gets the session JSON (with its `cwd`) on stdin. An MCP server gets
 * a JSON-RPC stream that does not end, so it uses the process directory.
 */
async function sessionCwd(command: "mcp" | "hook"): Promise<string> {
  if (command === "mcp" || process.stdin.isTTY) return process.cwd()
  try {
    return extractWorkspaceCwd(await readStdinJson()) ?? process.cwd()
  } catch {
    return process.cwd()
  }
}

function repair(cwd: string): string {
  const context = createOperationContext({ cwd })
  // Repair only a repository that has memory; never seed memory in another directory.
  if (!existsSync(resolve(context.cwd, ".ai", "memory"))) {
    return "This directory has no .ai/memory, so there is nothing to repair."
  }
  const entries = findLegacyMemoryEntries(context)
  if (entries.length === 0) {
    return "This repository has no 0.2.0 memory entry to repair."
  }
  // A home entry stays after the repair, so its host counts only while the
  // repository has no capture hook for it. Else each run would repair again.
  const captureHook: Record<Client, string> = {
    cursor: ".cursor/hooks.json",
    claude: ".claude/settings.json",
    codex: ".codex/config.toml",
    vscode: ".github/hooks/ctxpipe-memory.json",
    opencode: ".opencode/plugins/ctxpipe-memory.js",
  }
  const pending = entries.filter(
    ({ path, host }) =>
      isInside(context.cwd, path) ||
      (host && !hasCaptureHook(resolve(context.cwd, captureHook[host]))),
  )
  if (pending.length === 0) {
    return "The memory setup of this repository is already current."
  }
  const hosts = [
    ...new Set(pending.flatMap(({ host }) => (host ? [host] : []))),
  ]

  // Write the new hooks first and remove the 0.2.0 entries last. If a write
  // fails, the 0.2.0 entries stay, and the next run tries the repair again.
  const operations = [
    ...buildMemoryArtifactOperations({ context }),
    ...buildMemoryHookOperations({ clients: hosts, scope: "repo", context }),
    ...buildMemoryUpgradeOperations({ context }),
  ].filter((op) => !("path" in op) || isInside(context.cwd, op.path))
  // The upgrade also reads patterns.md, and the writes follow symlinks. A
  // cloned repository must not make the repair read or write outside it.
  const root = realpathSync(context.cwd)
  const escape = [
    resolve(context.cwd, ".ai", "memory", "patterns.md"),
    ...operations.flatMap((op) => ("path" in op ? [op.path] : [])),
  ].find((path) => !isInside(root, realTarget(path)))
  if (escape) {
    throw new Error(
      `${relative(context.cwd, escape)} resolves to a path outside the repository`,
    )
  }

  applyOperations(operations)
  const labels = hosts.map((host) => CLIENT_LABELS[host]).join(", ")
  return hosts.length > 0
    ? `Removed the 0.2.0 memory entries of this repository and wrote the capture hooks for ${labels}.`
    : "Removed the 0.2.0 memory entries of this repository."
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

/** The real path of `path`, also when it does not exist yet (the real path of its nearest existing parent). */
function realTarget(path: string): string {
  if (existsSync(path)) return realpathSync(path)
  const parent = dirname(path)
  if (parent === path) return path
  return join(realTarget(parent), basename(path))
}
