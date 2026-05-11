import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
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

export type Operation = WriteJsonOperation | RunOperation | ManualOperation

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
  context = createOperationContext(),
}: {
  baseUrl: string
  org: string
  clients: Client[]
  context?: OperationContext
}): WriteJsonOperation {
  const configPath = resolve(context.cwd, ".ctxpipe", "config.json")
  return {
    type: "write-json",
    path: configPath,
    description: `write repo ctxpipe config at ${relativePath(configPath, context.cwd)}`,
    content(existing = {}) {
      return {
        ...existing,
        orgSlug: org,
        baseUrl: baseUrl.replace(/\/+$/, ""),
        mcp: {
          ...(isObject(existing.mcp) ? existing.mcp : {}),
          url: mcpUrl({ baseUrl, org }),
          clients,
        },
      }
    },
  }
}

export function buildMcpOperations({
  clients,
  baseUrl,
  org,
  scope,
  context = createOperationContext(),
}: {
  clients: Client[]
  baseUrl: string
  org: string
  scope: Scope
  context?: OperationContext
}): Operation[] {
  return clients.flatMap((client) =>
    scopesFor(scope).flatMap((singleScope) =>
      buildClientOperations({ client, baseUrl, org, scope: singleScope, context }),
    ),
  )
}

export function buildClientOperations({
  client,
  baseUrl,
  org,
  scope,
  context = createOperationContext(),
}: {
  client: Client
  baseUrl: string
  org: string
  scope: "repo" | "user"
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
        }),
      ]
    case "claude":
      if (scope === "user" && context.commandExists("claude")) {
        return [
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
      }
      return [
        writeMcpServersOperation({
          path: resolve(context.cwd, ".mcp.json"),
          url,
          label: "Claude Code project",
          cwd: context.cwd,
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
        }),
      ]
    case "vscode":
      if (scope === "user") {
        return [
          {
            type: "manual",
            description: "open VS Code MCP install link",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({ name: "ctxpipe", type: "http", url }),
            )}`,
          },
        ]
      }
      return [
        writeVsCodeOperation({
          path: resolve(context.cwd, ".vscode", "mcp.json"),
          url,
          cwd: context.cwd,
        }),
      ]
    case "codex":
      if (scope === "user" && context.commandExists("codex")) {
        return [
          {
            type: "run",
            command: ["codex", "mcp", "add", "ctxpipe", "--url", url],
            description: "run Codex MCP add command",
          },
        ]
      }
      return [
        {
          type: "manual",
          description: "show Codex MCP add command",
          detail: `Run: codex mcp add ctxpipe --url ${url}`,
        },
      ]
  }
}

export function writeMcpServersOperation({
  path,
  url,
  label,
  cwd,
}: {
  path: string
  url: string
  label: string
  cwd: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure ${label} MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      return {
        ...existing,
        mcpServers: {
          ...(isObject(existing.mcpServers) ? existing.mcpServers : {}),
          ctxpipe: {
            type: "streamable-http",
            url,
          },
        },
      }
    },
  }
}

export function writeOpenCodeOperation({
  path,
  url,
  cwd,
}: {
  path: string
  url: string
  cwd: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure OpenCode MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      return {
        ...existing,
        mcp: {
          ...(isObject(existing.mcp) ? existing.mcp : {}),
          ctxpipe: {
            type: "remote",
            url,
            enabled: true,
          },
        },
      }
    },
  }
}

export function writeVsCodeOperation({
  path,
  url,
  cwd,
}: {
  path: string
  url: string
  cwd: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure VS Code MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      return {
        ...existing,
        servers: {
          ...(isObject(existing.servers) ? existing.servers : {}),
          ctxpipe: {
            type: "http",
            url,
          },
        },
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

export function operationDirectory(operation: Operation): string | null {
  return operation.type === "write-json" ? dirname(operation.path) : null
}
