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
import { trustedPath } from "../system.js"
import { extractWorkspaceCwd, readStdinJson } from "./capture.js"
import { buildMemoryHookOperations } from "./hooks.js"
import {
  buildMemoryUpgradeOperations,
  findLegacyMemoryEntries,
  legacyMemoryFilePaths,
} from "./upgrade.js"

/**
 * CLI 0.2.0 wrote hooks and MCP entries that run `memory mcp` and
 * `memory hook`; 0.3.0 removed these commands. Hooks run the newest release,
 * so the old commands repair the setup. They remove each 0.2.0 entry where it
 * is: in the repository and in the home directory. In a repository that has
 * `.ai/memory`, they also apply the `memory init` upgrade and write the repo
 * capture hook of each host that has a repo 0.2.0 entry. In another
 * directory, they only remove the entries. A second run finds no 0.2.0 entry
 * and changes nothing.
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
  // `npx` puts the `node_modules/.bin` folders of the repository on PATH, so
  // a cloned repository could plant a `git` or `claude` command. The repair
  // starts commands only from the other PATH folders.
  // An empty PATH makes a command lookup use the current folder, so fall back
  // to the system folders, and stop when none is trusted.
  const path = trustedPath(cwd) || trustedPath(cwd, "/usr/bin:/bin")
  if (!path) throw new Error("no PATH folder outside the repository")
  process.env.PATH = path
  const context = createOperationContext({ cwd })
  const entries = findLegacyMemoryEntries(context)
  if (entries.length === 0) {
    return "This setup has no 0.2.0 memory entry to repair."
  }
  // A repo 0.2.0 entry becomes the repo capture hook of its host, and it
  // starts the `memory init` steps in a repository with memory. A home entry
  // is only removed. A file that is also a home file (the repository is the
  // home directory) counts as a home file.
  const userFiles = new Set(
    entries
      .filter(({ scope }) => scope === "user")
      .map(({ path }) => realTarget(path)),
  )
  const repoEntries = entries.filter(
    ({ path, scope }) => scope === "repo" && !userFiles.has(realTarget(path)),
  )
  const repairRepo =
    repoEntries.length > 0 && existsSync(resolve(context.cwd, ".ai", "memory"))
  const hosts = repairRepo
    ? [...new Set(repoEntries.flatMap(({ host }) => (host ? [host] : [])))]
    : []

  // Remove the 0.2.0 entries last. If a step fails, the entries stay, and the
  // next run tries the repair again. Outside the repository, change only the
  // files that hold a 0.2.0 entry.
  const entryFiles = new Set(entries.map(({ path }) => path))
  const isRemoval = (op: Operation) =>
    op.type === "run" ||
    op.type === "manual" ||
    ("path" in op && entryFiles.has(op.path))
  // Change a file that can hold a 0.2.0 entry only when it holds one, so
  // that a file with no entry (for example a JSONC .vscode/mcp.json) does not
  // stop the repair.
  const legacyFiles = legacyMemoryFilePaths(context)
  const upgradeOps = buildMemoryUpgradeOperations({ context }).filter(
    (op) =>
      isRemoval(op) ||
      (repairRepo &&
        "path" in op &&
        isInside(context.cwd, op.path) &&
        !legacyFiles.has(op.path)),
  )
  const operations = [
    ...(repairRepo ? buildMemoryArtifactOperations({ context }) : []),
    ...buildMemoryHookOperations({ clients: hosts, scope: "repo", context }),
    ...upgradeOps.filter((op) => !isRemoval(op)),
    ...upgradeOps.filter(isRemoval),
  ]
  // A cloned repository can hold symlinks. So refuse each path that goes
  // through a symlink, also to a target in the repository (for example
  // .git/config) or in the home directory. This includes each file with a
  // 0.2.0 entry, also ~/.claude.json, which the `claude` CLI changes. The ops
  // hold patterns.md (a read) and lessons-learned.md. Refuse a JSON file that
  // does not parse too: the write would replace it with an empty object.
  for (const path of new Set([
    ...entryFiles,
    ...operations.flatMap((op) => ("path" in op ? [op.path] : [])),
  ])) {
    const root = isInside(context.cwd, path) ? context.cwd : context.homeDir
    if (
      !isInside(root, path) ||
      realTarget(path) !== join(realpathSync(root), relative(root, path))
    ) {
      throw new Error(`${displayPath(path, context)} goes through a symlink`)
    }
  }
  for (const op of operations) {
    if (op.type === "write-json" && existsSync(op.path)) {
      assertJsonObject(op.path, context)
    }
  }

  applyOperations(operations)
  const done =
    hosts.length > 0
      ? `Removed the 0.2.0 memory entries and wrote the capture hooks of this repository for ${hosts.map((host) => CLIENT_LABELS[host]).join(", ")}.`
      : "Removed the 0.2.0 memory entries."
  const manual = operations.find((op) => op.type === "manual")
  if (!manual) return done
  // An entry that only a manual step removes stays, so later runs report it again.
  return operations.some((op) => isRemoval(op) && op.type !== "manual")
    ? `${done} Not removed: ${manual.detail}`
    : `Not removed: ${manual.detail}`
}

/** A path for the stderr line: relative to the repository, or `~/…` in the home directory. */
function displayPath(path: string, context: OperationContext): string {
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
    throw new Error(`${displayPath(path, context)} is not a JSON object`)
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
