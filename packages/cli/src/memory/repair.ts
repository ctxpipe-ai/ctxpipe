import { existsSync, readFileSync, realpathSync } from "node:fs"
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path"

import { CLIENT_LABELS } from "../constants.js"
import { applyOperations } from "../fs-operations.js"
import { isObject } from "../mcp/json.js"
import type { Operation, OperationContext } from "../mcp/mcp-operations.js"
import {
  buildMemoryArtifactOperations,
  createOperationContext,
} from "../mcp/mcp-operations.js"
import { commandExists } from "../system.js"
import { extractWorkspaceCwd, readStdinJson } from "./capture.js"
import { buildMemoryHookOperations } from "./hooks.js"
import {
  buildMemoryUpgradeOperations,
  findLegacyMemoryEntries,
} from "./upgrade.js"

/**
 * CLI 0.2.0 wrote hooks and MCP entries that run `memory mcp` and
 * `memory hook`; 0.3.0 removed these commands. Hooks run the newest release,
 * so the old commands repair the setup: in a repository that has
 * `.ai/memory`, they write the repo capture hooks of each host that has a
 * 0.2.0 entry, apply the `memory init` upgrade, and remove each 0.2.0 entry
 * where it is: in the repository and in the home directory. A second run
 * finds no 0.2.0 entry and changes nothing.
 *
 * A home entry does not become a user-scope capture hook: such a hook writes
 * `.ai/memory/events/` into each directory where a session starts, also one
 * with no memory.
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
  const context = createOperationContext({ cwd, commandExists })
  // Repair only a repository that has memory; never seed memory in another directory.
  if (!existsSync(resolve(context.cwd, ".ai", "memory"))) {
    return "This directory has no .ai/memory, so there is nothing to repair. To repair a repository, run `npx ctxpipe memory init` in it."
  }
  const entries = findLegacyMemoryEntries(context)
  if (entries.length === 0) {
    return "This repository has no 0.2.0 memory entry to repair."
  }
  const hosts = [
    ...new Set(entries.flatMap(({ host }) => (host ? [host] : []))),
  ]

  // Remove the 0.2.0 entries last. If a step fails, the entries stay, and the
  // next run tries the repair again. In the home directory, change only the
  // files that hold a 0.2.0 entry.
  const entryFiles = new Set(entries.map(({ path }) => path))
  const isRemoval = (op: Operation) =>
    op.type === "run" || ("path" in op && entryFiles.has(op.path))
  const upgradeOps = buildMemoryUpgradeOperations({ context }).filter(
    (op) =>
      !("path" in op) ||
      isInside(context.cwd, op.path) ||
      entryFiles.has(op.path),
  )
  const operations = [
    ...buildMemoryArtifactOperations({ context }),
    ...buildMemoryHookOperations({ clients: hosts, scope: "repo", context }),
    ...upgradeOps.filter((op) => !isRemoval(op)),
    ...upgradeOps.filter(isRemoval),
  ]
  // A cloned repository can hold symlinks, and the upgrade reads patterns.md
  // and writes lessons-learned.md. So refuse each path that goes through a
  // symlink, also to a target in the repository (for example .git/config) or
  // in the home directory. Refuse a JSON file that does not parse too: the
  // write would replace it with an empty object.
  for (const path of [
    resolve(context.cwd, ".ai", "memory", "patterns.md"),
    ...operations.flatMap((op) => ("path" in op ? [op.path] : [])),
  ]) {
    const root = isInside(context.cwd, path) ? context.cwd : context.homeDir
    if (
      !isInside(root, path) ||
      realTarget(path) !== join(realpathSync(root), relative(root, path))
    ) {
      throw new Error(`${shown(path, context)} goes through a symlink`)
    }
  }
  for (const op of operations) {
    if (op.type === "write-json" && existsSync(op.path)) {
      assertJsonObject(op.path, context)
    }
  }

  applyOperations(operations)
  const labels = hosts.map((host) => CLIENT_LABELS[host]).join(", ")
  return hosts.length > 0
    ? `Removed the 0.2.0 memory entries and wrote the capture hooks of this repository for ${labels}.`
    : "Removed the 0.2.0 memory entries."
}

/** A path for the stderr line: relative to the repository, or `~/…` in the home directory. */
function shown(path: string, context: OperationContext): string {
  return isInside(context.cwd, path)
    ? relative(context.cwd, path)
    : `~/${relative(context.homeDir, path)}`
}

function assertJsonObject(path: string, context: OperationContext): void {
  let value: unknown
  try {
    value = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    value = null
  }
  if (!isObject(value)) {
    throw new Error(`${shown(path, context)} is not a JSON object`)
  }
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
