import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { Client } from "../constants.js"
import { isObject, parseJsonObject } from "../mcp/json.js"
import type {
  Operation,
  OperationContext,
  WriteJsonOperation,
  WriteTextOperation,
} from "../mcp/mcp-operations.js"
import { createOperationContext } from "../mcp/mcp-operations.js"
import { relativePath } from "../mcp/paths.js"
import { LESSONS_SEED, MEMORY_README_SEED } from "./seed.js"

/** Legacy AgentMemory / ConKeeper guidance that must not survive re-init. */
function isLegacyMemoryDoc(text: string): boolean {
  // Require multiple signals so a single negated mention ("do not use AgentMemory")
  // does not wipe a custom README.
  let score = 0
  if (
    /\bagentmemory\b/i.test(text) &&
    !/\b(?:do not|don't|never|without|no longer)\b[^\n]{0,40}\bagentmemory\b/i.test(
      text,
    )
  ) {
    score += 1
  }
  if (
    /\bctxpipe-memory\b/i.test(text) &&
    !/\b(?:do not|don't|never|without|strips?|remove[sd]?)\b[^\n]{0,48}\bctxpipe-memory\b/i.test(
      text,
    )
  ) {
    score += 1
  }
  if (
    /npx\s+[^\n]*\bmemory\s+mcp\b/i.test(text) &&
    !/\b(?:do not|don't|never|without|avoid)\b[^\n]{0,48}npx\s+[^\n]*\bmemory\s+mcp\b/i.test(
      text,
    )
  ) {
    score += 2
  }
  if (/conkeeper/i.test(text)) score += 2
  // memory-search is a current skill (ADR-024), not a retired one.
  if (/memory-(?:sync|init|reflect|insights)/i.test(text)) score += 1
  if (/\bpatterns\.md\b/i.test(text) && /lessons-learned/i.test(text)) {
    score += 1
  }
  return score >= 2
}

/**
 * Strip retired local-memory MCP tables from Codex config.toml
 * (e.g. `[mcp_servers.ctxpipe-memory]` from `codex mcp add`).
 */
function stripLegacyCodexMemoryToml(existing: string): string {
  // Match section headers even when indented; stop at the next header line.
  let text = existing.replace(
    /^[ \t]*\[(?:mcp_servers|mcp\.servers)\.ctxpipe-memory\][^\n]*(?:\n(?![ \t]*\[)[^\n]*)*/gm,
    "",
  )
  // Drop orphaned blank runs introduced by section removal.
  text = text.replace(/\n{3,}/g, "\n\n")
  if (!text.trim()) return text.endsWith("\n") ? "\n" : text
  return text.endsWith("\n") ? text : `${text}\n`
}

const RETIRED_SKILLS = [
  "memory-init",
  "memory-sync",
  // memory-search is reintroduced as Markdown+rg recall (ADR-024) — do not delete.
  "memory-reflect",
  "memory-insights",
  "session-handoff",
] as const

const RETIRED_RULES = ["project-memory.mdc"] as const

/** True only for the retired local memory MCP / hook paths — not the remote product MCP. */
function isLegacyLocalMemoryServer(key: string, value: unknown): boolean {
  if (key === "ctxpipe-memory") return true
  if (typeof value === "string") {
    return /memory mcp|memory hook|agentmemory/i.test(value)
  }
  if (!isObject(value)) return false
  const cmd = typeof value.command === "string" ? value.command : ""
  const args = Array.isArray(value.args)
    ? value.args.filter((a): a is string => typeof a === "string").join(" ")
    : ""
  const joined = `${cmd} ${args}`
  // Keep remote URL-based `ctxpipe` entries (no memory mcp/hook).
  if (typeof value.url === "string" && value.url.includes("/mcp")) return false
  return (
    /memory mcp|agentmemory/i.test(joined) ||
    (/memory hook/i.test(joined) && !/memory capture/i.test(joined))
  )
}

function stripServerMap(
  servers: Record<string, unknown>,
): Record<string, unknown> {
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(servers)) {
    if (isLegacyLocalMemoryServer(key, value)) continue
    next[key] = value
  }
  return next
}

/** Strip legacy AgentMemory MCP + memory stanza from JSON configs. */
function stripLegacyMemoryMcp(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...existing }
  for (const key of ["mcpServers", "servers", "mcp"] as const) {
    if (isObject(next[key])) {
      next[key] = stripServerMap(next[key] as Record<string, unknown>)
    }
  }
  if ("memory" in next) {
    delete next.memory
  }
  return next
}

function stripMcpJsonOperation(
  path: string,
  context: OperationContext,
): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `remove legacy ctxpipe-memory MCP from ${relativePath(path, context.cwd)}`,
    content(existing = {}) {
      return stripLegacyMemoryMcp(existing)
    },
  }
}

function isLegacyMemoryHookCommand(cmd: string): boolean {
  if (/memory capture/i.test(cmd)) return false
  return /memory hook|memory mcp|agentmemory/i.test(cmd)
}

function stripLegacyClaudeHooks(
  existing: Record<string, unknown>,
): Record<string, unknown> {
  if (!isObject(existing.hooks)) return existing
  const hooks = { ...(existing.hooks as Record<string, unknown>) }
  for (const [event, matchers] of Object.entries(hooks)) {
    if (!Array.isArray(matchers)) continue
    hooks[event] = matchers
      .map((matcher) => {
        if (!isObject(matcher)) return matcher
        const inner = Array.isArray(matcher.hooks) ? matcher.hooks : null
        if (!inner) {
          const cmd = typeof matcher.command === "string" ? matcher.command : ""
          if (isLegacyMemoryHookCommand(cmd)) return null
          return matcher
        }
        const nextInner = inner.filter((hook) => {
          if (!isObject(hook)) return true
          const cmd = typeof hook.command === "string" ? hook.command : ""
          return !isLegacyMemoryHookCommand(cmd)
        })
        if (nextInner.length === 0) return null
        return { ...matcher, hooks: nextInner }
      })
      .filter((m) => m !== null)
  }
  return { ...existing, hooks }
}

function migratePatternsToLessonsOperation(
  context: OperationContext,
): WriteTextOperation {
  const memoryRoot = resolve(context.cwd, ".ai", "memory")
  const patternsPath = resolve(memoryRoot, "patterns.md")
  const lessonsPath = resolve(memoryRoot, "lessons-learned.md")
  return {
    type: "write-text",
    path: lessonsPath,
    description: "migrate patterns.md into lessons-learned.md when present",
    content(existing) {
      if (!existsSync(patternsPath)) {
        return existing ?? LESSONS_SEED
      }
      const patterns = readFileSync(patternsPath, "utf8")
      if (!patterns.trim()) return existing ?? LESSONS_SEED
      if (existing?.includes("Migrated from former `patterns.md`")) {
        return existing
      }
      const header = existing?.trim()
        ? existing.trimEnd()
        : LESSONS_SEED.trimEnd()
      return `${header}\n\n## Migrated from former \`patterns.md\`\n\n${patterns.trim()}\n`
    },
  }
}

function pushRetiredSkillAndRuleRemovals(ops: Operation[], root: string): void {
  const skillsRoot = resolve(root, "skills")
  const rulesRoot = resolve(root, "rules")
  for (const name of RETIRED_SKILLS) {
    ops.push({
      type: "remove-path",
      path: resolve(skillsRoot, name),
      description: `remove retired skill ${name} under ${relativePath(skillsRoot, root)}`,
    })
  }
  for (const name of RETIRED_RULES) {
    ops.push({
      type: "remove-path",
      path: resolve(rulesRoot, name),
      description: `remove retired rule ${name}`,
    })
  }
}

/** The files in which CLI 0.2.0 wrote memory MCP entries and hooks, with the host of each. */
function legacyMemoryFiles({ cwd, homeDir }: OperationContext) {
  const mcpFiles: Array<[string, Client | null]> = [
    [resolve(cwd, ".cursor", "mcp.json"), "cursor"],
    [join(homeDir, ".cursor", "mcp.json"), "cursor"],
    [resolve(cwd, ".mcp.json"), "claude"],
    [resolve(cwd, ".vscode", "mcp.json"), "vscode"],
    [resolve(cwd, "opencode.json"), "opencode"],
    [join(homeDir, ".config", "opencode", "opencode.json"), "opencode"],
    [resolve(cwd, ".agents", "mcp.json"), null],
    [resolve(cwd, ".ctxpipe", "config.json"), null],
  ]
  const claudeSettings = [
    join(homeDir, ".claude", "settings.json"),
    join(homeDir, ".claude", "settings.local.json"),
    resolve(cwd, ".claude", "settings.json"),
    resolve(cwd, ".claude", "settings.local.json"),
  ]
  const codexConfigs = [
    resolve(cwd, ".codex", "config.toml"),
    join(homeDir, ".codex", "config.toml"),
  ]
  return { mcpFiles, claudeSettings, codexConfigs }
}

/**
 * One-shot upgrade ops so re-init leaves no AgentMemory / ConKeeper dual layout.
 */
export function buildMemoryUpgradeOperations({
  context = createOperationContext(),
}: {
  context?: OperationContext
} = {}): Operation[] {
  const ops: Operation[] = []
  const cwd = context.cwd
  const memoryRoot = resolve(cwd, ".ai", "memory")

  const { mcpFiles, claudeSettings, codexConfigs } = legacyMemoryFiles(context)

  // MCP / config cleanup — only touch files that already exist (do not create empties).
  for (const [path] of mcpFiles) {
    if (existsSync(path)) ops.push(stripMcpJsonOperation(path, context))
  }

  // Codex TOML (user + repo): strip ctxpipe-memory MCP tables from `codex mcp add`.
  for (const path of codexConfigs) {
    if (!existsSync(path)) continue
    ops.push({
      type: "write-text",
      path,
      description: `strip legacy ctxpipe-memory from Codex config ${relativePath(path, context.cwd)}`,
      content(existing) {
        return stripLegacyCodexMemoryToml(existing ?? "")
      },
    })
  }

  // Replace AgentMemory-era README so skipIfExists seed cannot leave dual guidance.
  const readmePath = resolve(memoryRoot, "README.md")
  if (existsSync(readmePath)) {
    ops.push({
      type: "write-text",
      path: readmePath,
      description:
        "replace legacy AgentMemory README with ADR-024 seed when detected",
      content(existing) {
        if (existing && isLegacyMemoryDoc(existing)) return MEMORY_README_SEED
        return existing ?? MEMORY_README_SEED
      },
    })
  }

  // Claude settings: strip retired memory hook commands (user + project).
  for (const path of claudeSettings) {
    if (!existsSync(path)) continue
    ops.push({
      type: "write-json",
      path,
      description: `strip legacy Claude memory hooks from ${relativePath(path, context.cwd)}`,
      content(existing = {}) {
        return stripLegacyClaudeHooks(existing)
      },
    })
  }

  // Migrate patterns → lessons, then remove patterns.md
  ops.push(migratePatternsToLessonsOperation(context))
  ops.push({
    type: "remove-path",
    path: resolve(memoryRoot, "patterns.md"),
    description: "remove legacy patterns.md after migration",
  })

  // Retired ConKeeper skills / rule — both Cursor-primary and legacy .agents roots
  pushRetiredSkillAndRuleRemovals(ops, resolve(cwd, ".cursor"))
  // Only if .agents is a real directory (not the same inode as .cursor via symlink).
  const agentsRoot = resolve(cwd, ".agents")
  if (existsSync(agentsRoot)) {
    pushRetiredSkillAndRuleRemovals(ops, agentsRoot)
  }

  // Legacy decisions/sessions README routers (replaced by index.md)
  ops.push({
    type: "remove-path",
    path: resolve(memoryRoot, "decisions", "README.md"),
    description: "remove legacy decisions/README.md (use index.md)",
  })
  ops.push({
    type: "remove-path",
    path: resolve(memoryRoot, "sessions", "README.md"),
    description: "remove legacy sessions/README.md (use index.md)",
  })

  return ops
}

/**
 * Finds the entries of CLI 0.2.0 (the `ctxpipe-memory` MCP server and the
 * `memory hook` commands) in the files that the upgrade cleans. Returns null
 * when there is no such entry. Else returns the hosts that hold one, so that
 * a repair can write the current capture hooks for them.
 */
export function findLegacyMemoryHosts(
  context: OperationContext,
): Client[] | null {
  const { mcpFiles, claudeSettings, codexConfigs } = legacyMemoryFiles(context)
  const read = (path: string) =>
    existsSync(path) ? readFileSync(path, "utf8") : null
  const changes = (
    path: string,
    strip: (o: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const text = read(path)
    if (text == null) return false
    const existing = parseJsonObject(text)
    return JSON.stringify(strip(existing)) !== JSON.stringify(existing)
  }

  let found = false
  const hosts = new Set<Client>()
  const mark = (host: Client | null) => {
    found = true
    if (host) hosts.add(host)
  }
  for (const [path, host] of mcpFiles) {
    if (changes(path, stripLegacyMemoryMcp)) mark(host)
  }
  for (const path of claudeSettings) {
    if (changes(path, stripLegacyClaudeHooks)) mark("claude")
  }
  for (const path of codexConfigs) {
    if (
      /^[ \t]*\[(?:mcp_servers|mcp\.servers)\.ctxpipe-memory\]/m.test(
        read(path) ?? "",
      )
    ) {
      mark("codex")
    }
  }
  return found ? [...hosts] : null
}
