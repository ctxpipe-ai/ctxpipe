import { existsSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"

import type { Client } from "../constants.js"
import { readJsonObject } from "../fs-operations.js"
import { isObject } from "../mcp/json.js"
import type {
  Operation,
  OperationContext,
  WriteJsonOperation,
  WriteTextOperation,
} from "../mcp/mcp-operations.js"
import { createOperationContext } from "../mcp/mcp-operations.js"
import { relativePath } from "../mcp/paths.js"
import { CODEX_HOOKS_MARKER_START } from "./hooks.js"
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
 * A `[mcp_servers.ctxpipe-memory]` table from `codex mcp add`, to the next
 * table header or to the start of the managed capture-hook block. The repair
 * writes that block before it removes the table, so the strip must keep it.
 */
const LEGACY_CODEX_MEMORY_TABLE = new RegExp(
  String.raw`^[ \t]*\[(?:mcp_servers|mcp\.servers)\.ctxpipe-memory\][^\n]*(?:\n(?![ \t]*\[|${CODEX_HOOKS_MARKER_START})[^\n]*)*`,
  "gm",
)

/** Strip retired local-memory MCP tables from Codex config.toml. */
function stripLegacyCodexMemoryToml(existing: string): string {
  let text = existing.replace(LEGACY_CODEX_MEMORY_TABLE, "")
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
  // `claude mcp add --scope user` keeps its servers in this file.
  const claudeUserConfig = join(homeDir, ".claude.json")
  return { mcpFiles, claudeSettings, codexConfigs, claudeUserConfig }
}

/** Each file in which CLI 0.2.0 can have written a memory MCP entry or hook. */
export function legacyMemoryFilePaths(context: OperationContext): Set<string> {
  const { mcpFiles, claudeSettings, codexConfigs, claudeUserConfig } =
    legacyMemoryFiles(context)
  return new Set([
    ...mcpFiles.map(([path]) => path),
    ...claudeSettings,
    ...codexConfigs,
    claudeUserConfig,
  ])
}

/**
 * The keys of the 0.2.0 memory servers in the top-level `mcpServers` of
 * `~/.claude.json`. Claude Code writes that file while it runs, so only the
 * `claude` CLI removes them.
 */
function legacyClaudeUserServers(path: string): string[] {
  if (!existsSync(path)) return []
  const servers = readJsonObject(path).mcpServers
  if (!isObject(servers)) return []
  return Object.entries(servers)
    .filter(([key, value]) => isLegacyLocalMemoryServer(key, value))
    .map(([key]) => key)
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

  const { mcpFiles, claudeSettings, codexConfigs, claudeUserConfig } =
    legacyMemoryFiles(context)

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

  // Claude user MCP servers (`claude mcp add ctxpipe-memory --scope user`).
  const claudeServers = legacyClaudeUserServers(claudeUserConfig)
  const hasClaude = claudeServers.length > 0 && context.commandExists("claude")
  for (const key of claudeServers) {
    const command = ["claude", "mcp", "remove", key, "--scope", "user"]
    ops.push(
      hasClaude
        ? {
            type: "run",
            command,
            description: `remove the legacy ${key} MCP server from Claude Code (user scope)`,
          }
        : {
            type: "manual",
            description: `remove the legacy ${key} MCP server from Claude Code (user scope)`,
            detail: `The claude command is not available. Run: ${command.join(" ")}`,
          },
    )
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
 * `memory hook` commands) in the files that the upgrade cleans. Returns the
 * file and the host of each, so that a repair can write the current capture
 * hooks for these hosts.
 */
export function findLegacyMemoryEntries(
  context: OperationContext,
): Array<{ path: string; host: Client | null }> {
  const { mcpFiles, claudeSettings, codexConfigs, claudeUserConfig } =
    legacyMemoryFiles(context)
  const hasLegacyEntry = (
    path: string,
    strip: (o: Record<string, unknown>) => Record<string, unknown>,
  ) => {
    const existing = readJsonObject(path)
    return JSON.stringify(strip(existing)) !== JSON.stringify(existing)
  }

  return [
    ...mcpFiles.filter(([path]) => hasLegacyEntry(path, stripLegacyMemoryMcp)),
    ...claudeSettings
      .filter((path) => hasLegacyEntry(path, stripLegacyClaudeHooks))
      .map((path): [string, Client] => [path, "claude"]),
    // `search` ignores the lastIndex of a /g regex; `test` does not.
    ...codexConfigs
      .filter(
        (path) =>
          existsSync(path) &&
          readFileSync(path, "utf8").search(LEGACY_CODEX_MEMORY_TABLE) >= 0,
      )
      .map((path): [string, Client] => [path, "codex"]),
    ...(legacyClaudeUserServers(claudeUserConfig).length > 0
      ? [[claudeUserConfig, "claude"] as [string, Client]]
      : []),
  ].map(([path, host]) => ({ path, host }))
}
