import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Client, Scope } from "../constants.js"
import { CLIENTS } from "../constants.js"
import type { JsonObject } from "./json.js"
import { isObject } from "./json.js"
import { mcpUrl, relativePath, scopesFor } from "./paths.js"

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

export function buildCtxpipeConfigOperation({
  baseUrl,
  org,
  clients,
  memory,
  context = createOperationContext(),
}: {
  baseUrl: string
  org: string
  clients: Client[]
  memory?: boolean
  context?: OperationContext
}): WriteJsonOperation {
  const configPath = resolve(context.cwd, ".ctxpipe", "config.json")
  return {
    type: "write-json",
    path: configPath,
    description: `write repo ctxpipe config at ${relativePath(configPath, context.cwd)}`,
    content(existing = {}) {
      const next: JsonObject = {
        ...existing,
        orgSlug: org,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        mcp: {
          ...(isObject(existing.mcp) ? existing.mcp : {}),
          url: mcpUrl({ baseUrl, org }),
          clients,
        },
      }
      if (memory) {
        next.memory = {
          ...(isObject(existing.memory) ? existing.memory : {}),
          provider: "agentmemory",
          enabled: true,
          runtime: "ctxpipe-managed",
          agentmemoryVersion: "0.9.21",
          mode: "local-first",
          memoryRoot: ".ai/memory",
        }
      }
      return next
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
  context = createOperationContext(),
}: {
  client: Client
  baseUrl: string
  org: string
  scope: "repo" | "user"
  memory?: boolean
  context?: OperationContext
}): Operation[] {
  const url = mcpUrl({ baseUrl, org })
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
        }),
      ]
    case "claude":
      if (scope === "user" && context.commandExists("claude")) {
        const ops: Operation[] = [
          {
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
          },
        ]
        if (memory) {
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
        }),
      ]
    case "vscode":
      if (scope === "user") {
        const ops: Operation[] = [
          {
            type: "manual",
            description: "open VS Code MCP install link",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({ name: "ctxpipe", type: "http", url }),
            )}`,
          },
        ]
        if (memory) {
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
        }),
      ]
    case "codex":
      if (scope === "user" && context.commandExists("codex")) {
        const ops: Operation[] = [
          {
            type: "run",
            command: ["codex", "mcp", "add", "ctxpipe", "--url", url],
            description: "run Codex MCP add command",
          },
        ]
        if (memory) {
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
        const ops: Operation[] = [
          {
            type: "manual",
            description: "show Codex MCP add command",
            detail: `Run: codex mcp add ctxpipe --url ${url}`,
          },
        ]
        if (memory) {
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
}: {
  path: string
  url: string
  label: string
  cwd: string
  memory?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure ${label} MCP at ${relativePath(path, cwd)}${memory ? " (with ctxpipe-memory)" : ""}`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.mcpServers) ? existing.mcpServers : {}),
        ctxpipe: {
          type: "streamable-http",
          url,
        },
      }
      if (memory) {
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
}: {
  path: string
  url: string
  cwd: string
  memory?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure OpenCode MCP at ${relativePath(path, cwd)}${memory ? " (with ctxpipe-memory)" : ""}`,
    content(existing = {}) {
      const mcp: JsonObject = {
        ...(isObject(existing.mcp) ? existing.mcp : {}),
        ctxpipe: {
          type: "remote",
          url,
          enabled: true,
        },
      }
      if (memory) {
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
}: {
  path: string
  url: string
  cwd: string
  memory?: boolean
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure VS Code MCP at ${relativePath(path, cwd)}${memory ? " (with ctxpipe-memory)" : ""}`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.servers) ? existing.servers : {}),
        ctxpipe: {
          type: "http",
          url,
        },
      }
      if (memory) {
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
