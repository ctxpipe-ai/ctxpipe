import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname } from "node:path"

import type { JsonObject } from "./mcp/json.js"
import { parseJsonObject } from "./mcp/json.js"
import type { Operation } from "./mcp/mcp-operations.js"

export type ApplyOperationResult =
  | {
      status: "written" | "unchanged" | "created" | "skipped" | "removed"
      path: string
    }
  | { status: "ran" | "manual"; detail: string }

type ApplyResult = {
  status: "ok"
  operations: ApplyOperationResult[]
}

export function readJsonObject(path: string): JsonObject {
  return parseJsonObject(existsSync(path) ? readFileSync(path, "utf8") : null)
}

export function applyOperations(operations: Operation[]): ApplyResult {
  const results: ApplyOperationResult[] = []
  for (const op of operations) {
    results.push(applyOperation(op))
  }
  return { status: "ok", operations: results }
}

/**
 * Write through a temp file and a rename. The memory repair can run in two
 * processes at once (a session hook and an MCP server). A reader then sees the
 * old or the new file, never a partial one that parses as an empty object.
 * Writes go to the target of a symlink, so the link stays. The temp file has a
 * random name and is created only when it does not exist, so a planted file or
 * link at that name is never written through.
 */
function writeFileAtomic(path: string, content: string): void {
  const target = existsSync(path) ? realpathSync(path) : path
  mkdirSync(dirname(target), { recursive: true })
  const temp = `${target}.${randomUUID()}.tmp`
  writeFileSync(temp, content, {
    encoding: "utf8",
    flag: "wx",
    mode: existsSync(target) ? statSync(target).mode : 0o666,
  })
  try {
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, { force: true })
    throw error
  }
}

export function applyOperation(op: Operation): ApplyOperationResult {
  if (op.type === "write-json") {
    const existing = readJsonObject(op.path)
    const next = `${JSON.stringify(op.content(existing), null, 2)}\n`
    const previous = existsSync(op.path) ? readFileSync(op.path, "utf8") : null
    if (previous === next) {
      return { status: "unchanged", path: op.path }
    }
    writeFileAtomic(op.path, next)
    return { status: "written", path: op.path }
  }
  if (op.type === "write-text") {
    if (op.skipIfExists && existsSync(op.path)) {
      return { status: "skipped", path: op.path }
    }
    const previous = existsSync(op.path) ? readFileSync(op.path, "utf8") : null
    const next = op.content(previous)
    if (previous === next) {
      return { status: "unchanged", path: op.path }
    }
    writeFileAtomic(op.path, next)
    return { status: "written", path: op.path }
  }
  if (op.type === "mkdir") {
    if (existsSync(op.path)) {
      return { status: "unchanged", path: op.path }
    }
    mkdirSync(op.path, { recursive: true })
    return { status: "created", path: op.path }
  }
  if (op.type === "remove-path") {
    if (!existsSync(op.path)) {
      return { status: "unchanged", path: op.path }
    }
    rmSync(op.path, { recursive: true, force: true })
    return { status: "removed", path: op.path }
  }
  if (op.type === "run") {
    const command = op.command[0]
    if (!command) throw new Error("Cannot run an empty command")
    const result = spawnSync(command, op.command.slice(1), {
      encoding: "utf8",
      stdio: "pipe",
    })
    if (result.status !== 0) {
      throw new Error(
        `${op.command.join(" ")} failed: ${result.stderr || result.stdout}`,
      )
    }
    return { status: "ran", detail: op.command.join(" ") }
  }
  return { status: "manual", detail: op.detail }
}
