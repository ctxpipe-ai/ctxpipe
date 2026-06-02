import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Client, Scope } from "../constants.js"
import { CLIENTS, DEFAULT_BASE_URL } from "../constants.js"
import type { JsonObject } from "./json.js"
import { isObject } from "./json.js"
import { mcpUrl, normalizeBaseUrl, relativePath, scopesFor } from "./paths.js"

export type WriteJsonOperation = {
  type: "write-json"
  path: string
  description: string
  content: (existing?: JsonObject) => JsonObject
}

export type RunOperation = {
  type: "run"
  command: string[]
  description: string
}

export type ManualOperation = {
  type: "manual"
  description: string
  detail: string
}

export type WriteTextOperation = {
  type: "write-text"
  path: string
  description: string
  /** If true, never overwrite an existing file. */
  skipIfExists?: boolean
  content: (existing?: string | null) => string
}

export type MkdirOperation = {
  type: "mkdir"
  path: string
  description: string
}

export type Operation =
  | WriteJsonOperation
  | RunOperation
  | ManualOperation
  | WriteTextOperation
  | MkdirOperation

export type OperationContext = {
  cwd: string
  homeDir: string
  commandExists: (command: string) => boolean
}

export function createOperationContext(
  overrides: Partial<OperationContext> = {},
): OperationContext {
  return {
    cwd: process.cwd(),
    homeDir: homedir(),
    commandExists: () => false,
    ...overrides,
  }
}

function minimalRepoConfigFields({
  org,
  baseUrl,
  existing = {},
}: {
  org?: string | null
  baseUrl: string
  existing?: JsonObject
}): JsonObject {
  const next: JsonObject = {}
  const orgSlug =
    org ?? (typeof existing.orgSlug === "string" ? existing.orgSlug : undefined)
  if (orgSlug) next.orgSlug = orgSlug

  const urlSource =
    normalizeBaseUrl(baseUrl) !== DEFAULT_BASE_URL
      ? baseUrl
      : typeof existing.baseUrl === "string"
        ? existing.baseUrl
        : baseUrl
  const normalized = normalizeBaseUrl(urlSource)
  if (normalized !== DEFAULT_BASE_URL) {
    next.baseUrl = normalized
  }
  return next
}

export function buildCtxpipeConfigOperation({
  baseUrl,
  org,
  context = createOperationContext(),
}: {
  baseUrl: string
  org: string
  context?: OperationContext
}): WriteJsonOperation {
  const configPath = resolve(context.cwd, ".ctxpipe", "config.json")
  return {
    type: "write-json",
    path: configPath,
    description: `write repo ctxpipe config at ${relativePath(configPath, context.cwd)}`,
    content() {
      return minimalRepoConfigFields({ org, baseUrl })
    },
  }
}

/** Memory-only init: records org/baseUrl when org is known; preserves existing org on re-run. */
export function buildMemoryConfigOperation({
  org,
  baseUrl,
  context = createOperationContext(),
}: {
  org?: string | null
  baseUrl: string
  context?: OperationContext
}): WriteJsonOperation {
  const configPath = resolve(context.cwd, ".ctxpipe", "config.json")
  return {
    type: "write-json",
    path: configPath,
    description: `write memory config at ${relativePath(configPath, context.cwd)}`,
    content(existing = {}) {
      return minimalRepoConfigFields({ org, baseUrl, existing })
    },
  }
}

const MEMORY_README_SEED = `# .ai/memory

This folder is **canonical** ctx| project memory. It is the source of truth for
durable knowledge across coding-agent sessions: architecture decisions,
patterns, lessons, and curated session summaries.

The local \`ctxpipe-memory\` MCP server hydrates these Markdown files into a
per-repo AgentMemory cache so agents can search and recall them. The
AgentMemory cache is disposable — anything we want to keep belongs here, in
Markdown, and is reviewed via the normal Git diff workflow.

## Record shape

Every \`.md\` file under this tree carries YAML frontmatter so the hydration
layer can give each record a stable identity across renames, branch switches,
and merges:

\`\`\`md
---
id: mem-auth-session-refresh
type: architecture
concepts: [auth, sessions, better-auth]
files:
  - apps/backend/src/auth.ts
createdAt: 2026-05-25T00:00:00.000Z
updatedAt: 2026-05-25T00:00:00.000Z
---

# Auth Session Refresh

We refresh Better Auth sessions through ...
\`\`\`

## Rules

- \`id\` is the stable key — never rename it.
- Do not commit secrets, credentials, or private customer data here.
- Raw session logs and tool observations are local-only cache and must NOT be
  committed under this tree.
- See [ADR-021](decisions/ADR-021-local-agent-memory-agentmemory-hybrid-mcp-proxy.md)
  for the full design.
`

export function buildMemoryArtifactOperations({
  context = createOperationContext(),
}: {
  context?: OperationContext
} = {}): Operation[] {
  const memoryRoot = resolve(context.cwd, ".ai", "memory")
  const readme = resolve(memoryRoot, "README.md")
  return [
    {
      type: "mkdir",
      path: memoryRoot,
      description: `create canonical memory root at ${relativePath(memoryRoot, context.cwd)}`,
    },
    {
      type: "write-text",
      path: readme,
      description: `seed ${relativePath(readme, context.cwd)} (only if absent)`,
      skipIfExists: true,
      content: () => MEMORY_README_SEED,
    },
  ]
}

const CLAUDE_HOOK_BLOCK = {
  SessionStart: [
    {
      hooks: [
        {
          type: "command",
          command: "npx -y ctxpipe memory hook claude-session-start",
        },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        {
          type: "command",
          command: "npx -y ctxpipe memory hook claude-stop",
          async: true,
        },
      ],
    },
  ],
}

export function buildClaudeHooksOperation({
  context = createOperationContext(),
}: {
  context?: OperationContext
} = {}): WriteJsonOperation {
  const path = join(context.homeDir, ".claude", "settings.local.json")
  return {
    type: "write-json",
    path,
    description: `install Claude Code SessionStart/Stop hooks in ~/.claude/settings.local.json`,
    content(existing = {}) {
      const existingHooks = isObject(existing.hooks) ? existing.hooks : {}
      const sessionStartExisting = Array.isArray(
        (existingHooks as Record<string, unknown>).SessionStart,
      )
        ? ((existingHooks as Record<string, unknown[]>).SessionStart as unknown[])
        : []
      const stopExisting = Array.isArray(
        (existingHooks as Record<string, unknown>).Stop,
      )
        ? ((existingHooks as Record<string, unknown[]>).Stop as unknown[])
        : []
      return {
        ...existing,
        hooks: {
          ...existingHooks,
          SessionStart: dedupeHookEntries(sessionStartExisting, CLAUDE_HOOK_BLOCK.SessionStart),
          Stop: dedupeHookEntries(stopExisting, CLAUDE_HOOK_BLOCK.Stop),
        },
      }
    },
  }
}

function dedupeHookEntries(existing: unknown[], ours: unknown[]): unknown[] {
  // Drop any prior ctxpipe-installed entries before re-adding ours, so the
  // command is idempotent and `npx` upgrades don't double up the hook list.
  const filtered = existing.filter((entry) => !entryMentionsCtxpipe(entry))
  return [...filtered, ...ours]
}

function entryMentionsCtxpipe(entry: unknown): boolean {
  if (!isObject(entry)) return false
  const hooks = (entry as { hooks?: unknown }).hooks
  if (!Array.isArray(hooks)) return false
  return hooks.some((hook) => {
    if (!isObject(hook)) return false
    const cmd = (hook as { command?: unknown }).command
    return typeof cmd === "string" && cmd.includes("ctxpipe memory hook")
  })
}

export function buildMemoryMcpOperations({
  clients,
  baseUrl,
  org,
  scope,
  context = createOperationContext(),
}: {
  clients: Client[]
  baseUrl: string
  org?: string | null
  scope: Scope
  context?: OperationContext
}): Operation[] {
  const orgSlug = org ?? "local"
  return clients.flatMap((client) =>
    scopesFor(scope).flatMap((singleScope) =>
      buildClientOperations({
        client,
        baseUrl,
        org: orgSlug,
        scope: singleScope,
        memory: true,
        memoryOnly: true,
        context,
      }),
    ),
  )
}

export function buildMcpOperations({
  clients,
  baseUrl,
  org,
  scope,
  memory,
  context = createOperationContext(),
}: {
  clients: Client[]
  baseUrl: string
  org: string
  scope: Scope
  memory?: boolean
  context?: OperationContext
}): Operation[] {
  return clients.flatMap((client) =>
    scopesFor(scope).flatMap((singleScope) =>
      buildClientOperations({
        client,
        baseUrl,
        org,
        scope: singleScope,
        memory,
        context,
      }),
    ),
  )
}

export function buildClientOperations({
  client,
  baseUrl,
  org,
  scope,
  memory,
  memoryOnly,
  context = createOperationContext(),
}: {
  client: Client
  baseUrl: string
  org: string
  scope: "repo" | "user"
  memory?: boolean
  memoryOnly?: boolean
  context?: OperationContext
}): Operation[] {
  const url = mcpUrl({ baseUrl, org: org === "local" ? "local" : org })
  switch (client) {
    case "cursor":
      return [
        writeMcpServersOperation({
          path:
            scope === "user"
              ? join(context.homeDir, ".cursor", "mcp.json")
              : resolve(context.cwd, ".cursor", "mcp.json"),
          url,
          label: "Cursor",
          cwd: context.cwd,
          memory,
          memoryOnly,
        }),
      ]
    case "claude":
      if (scope === "user" && context.commandExists("claude")) {
        const ops: Operation[] = []
        if (!memoryOnly) {
          ops.push({
            type: "run",
            command: [
              "claude",
              "mcp",
              "add",
              "--transport",
              "http",
              "ctxpipe",
              "--scope",
              "user",
              url,
            ],
            description: "run Claude Code MCP add command",
          })
        }
        if (memory || memoryOnly) {
          ops.push({
            type: "run",
            command: [
              "claude",
              "mcp",
              "add",
              "ctxpipe-memory",
              "--scope",
              "user",
              "--",
              "npx",
              "-y",
              "ctxpipe",
              "memory",
              "mcp",
            ],
            description: "run Claude Code MCP add command for ctxpipe-memory",
          })
        }
        return ops
      }
      return [
        writeMcpServersOperation({
          path: resolve(context.cwd, ".mcp.json"),
          url,
          label: "Claude Code project",
          cwd: context.cwd,
          memory,
          memoryOnly,
        }),
      ]
    case "opencode":
      return [
        writeOpenCodeOperation({
          path:
            scope === "user"
              ? join(context.homeDir, ".config", "opencode", "opencode.json")
              : resolve(context.cwd, "opencode.json"),
          url,
          cwd: context.cwd,
          memory,
          memoryOnly,
        }),
      ]
    case "vscode":
      if (scope === "user") {
        const ops: Operation[] = []
        if (!memoryOnly) {
          ops.push({
            type: "manual",
            description: "open VS Code MCP install link",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({ name: "ctxpipe", type: "http", url }),
            )}`,
          })
        }
        if (memory || memoryOnly) {
          ops.push({
            type: "manual",
            description: "open VS Code MCP install link for ctxpipe-memory",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({
                name: "ctxpipe-memory",
                type: "stdio",
                command: "npx",
                args: ["-y", "ctxpipe", "memory", "mcp"],
              }),
            )}`,
          })
        }
        return ops
      }
      return [
        writeVsCodeOperation({
          path: resolve(context.cwd, ".vscode", "mcp.json"),
          url,
          cwd: context.cwd,
          memory,
          memoryOnly,
        }),
      ]
    case "codex":
      if (scope === "user" && context.commandExists("codex")) {
        const ops: Operation[] = []
        if (!memoryOnly) {
          ops.push({
            type: "run",
            command: ["codex", "mcp", "add", "ctxpipe", "--url", url],
            description: "run Codex MCP add command",
          })
        }
        if (memory || memoryOnly) {
          ops.push({
            type: "run",
            command: [
              "codex",
              "mcp",
              "add",
              "ctxpipe-memory",
              "--",
              "npx",
              "-y",
              "ctxpipe",
              "memory",
              "mcp",
            ],
            description: "run Codex MCP add command for ctxpipe-memory",
          })
        }
        return ops
      }
      {
        const ops: Operation[] = []
        if (!memoryOnly) {
          ops.push({
            type: "manual",
            description: "show Codex MCP add command",
            detail: `Run: codex mcp add ctxpipe --url ${url}`,
          })
        }
        if (memory || memoryOnly) {
          ops.push({
            type: "manual",
            description: "show Codex MCP add command for ctxpipe-memory",
            detail: `Run: codex mcp add ctxpipe-memory -- npx -y ctxpipe memory mcp`,
          })
        }
        return ops
      }
  }
}

export function writeMcpServersOperation({
  path,
  url,
  label,
  cwd,
  memory,
  memoryOnly,
}: {
  path: string
  url: string
  label: string
  cwd: string
  memory?: boolean
  memoryOnly?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure ${label} MCP at ${relativePath(path, cwd)}${
      memory || memoryOnly ? " (with ctxpipe-memory)" : ""
    }`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.mcpServers) ? existing.mcpServers : {}),
      }
      if (!memoryOnly) {
        servers.ctxpipe = {
          type: "streamable-http",
          url,
        }
      }
      if (memory || memoryOnly) {
        servers["ctxpipe-memory"] = {
          command: "npx",
          args: ["-y", "ctxpipe", "memory", "mcp"],
        }
      }
      return {
        ...existing,
        mcpServers: servers,
      }
    },
  }
}

export function writeOpenCodeOperation({
  path,
  url,
  cwd,
  memory,
  memoryOnly,
}: {
  path: string
  url: string
  cwd: string
  memory?: boolean
  memoryOnly?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure OpenCode MCP at ${relativePath(path, cwd)}${
      memory || memoryOnly ? " (with ctxpipe-memory)" : ""
    }`,
    content(existing = {}) {
      const mcp: JsonObject = {
        ...(isObject(existing.mcp) ? existing.mcp : {}),
      }
      if (!memoryOnly) {
        mcp.ctxpipe = {
          type: "remote",
          url,
          enabled: true,
        }
      }
      if (memory || memoryOnly) {
        mcp["ctxpipe-memory"] = {
          type: "local",
          command: ["npx", "-y", "ctxpipe", "memory", "mcp"],
          enabled: true,
        }
      }
      return {
        ...existing,
        mcp,
      }
    },
  }
}

export function writeVsCodeOperation({
  path,
  url,
  cwd,
  memory,
  memoryOnly,
}: {
  path: string
  url: string
  cwd: string
  memory?: boolean
  memoryOnly?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure VS Code MCP at ${relativePath(path, cwd)}${
      memory || memoryOnly ? " (with ctxpipe-memory)" : ""
    }`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.servers) ? existing.servers : {}),
      }
      if (!memoryOnly) {
        servers.ctxpipe = {
          type: "http",
          url,
        }
      }
      if (memory || memoryOnly) {
        servers["ctxpipe-memory"] = {
          type: "stdio",
          command: "npx",
          args: ["-y", "ctxpipe", "memory", "mcp"],
        }
      }
      return {
        ...existing,
        servers,
      }
    },
  }
}

export function validateScope(scope: string): asserts scope is Scope {
  if (!["repo", "user", "both"].includes(scope)) {
    throw new Error("--scope must be one of: repo, user, both")
  }
}

export function validateClients(clients: string[]): asserts clients is Client[] {
  for (const client of clients) {
    if (!CLIENTS.includes(client as Client)) {
      throw new Error(`Unsupported client "${client}". Use: ${CLIENTS.join(", ")}`)
    }
  }
}
