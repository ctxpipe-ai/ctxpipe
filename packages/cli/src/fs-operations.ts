import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import type { JsonObject } from "./mcp/json.js"
import { parseJsonObject } from "./mcp/json.js"
import type { Operation } from "./mcp/mcp-operations.js"

export type ApplyOperationResult =
  | { status: "written" | "unchanged" | "created" | "skipped"; path: string }
  | { status: "ran" | "manual"; detail: string }

export type ApplyResult = {
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

export function applyOperation(op: Operation): ApplyOperationResult {
  if (op.type === "write-json") {
    const existing = readJsonObject(op.path)
    const next = `${JSON.stringify(op.content(existing), null, 2)}\n`
    const previous = existsSync(op.path) ? readFileSync(op.path, "utf8") : null
    if (previous === next) {
      return { status: "unchanged", path: op.path }
    }
    mkdirSync(dirname(op.path), { recursive: true })
    writeFileSync(op.path, next, "utf8")
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
    mkdirSync(dirname(op.path), { recursive: true })
    writeFileSync(op.path, next, "utf8")
    return { status: "written", path: op.path }
  }
  if (op.type === "mkdir") {
    if (existsSync(op.path)) {
      return { status: "unchanged", path: op.path }
    }
    mkdirSync(op.path, { recursive: true })
    return { status: "created", path: op.path }
  }
  if (op.type === "run") {
    const command = op.command[0]
    if (!command) throw new Error("Cannot run an empty command")
    const result = spawnSync(command, op.command.slice(1), {
      encoding: "utf8",
      stdio: "pipe",
    })
    if (result.status !== 0) {
      throw new Error(`${op.command.join(" ")} failed: ${result.stderr || result.stdout}`)
    }
    return { status: "ran", detail: op.command.join(" ") }
  }
  return { status: "manual", detail: op.detail }
}
