import { homedir } from "node:os"
import { join, resolve } from "node:path"
import type { Client, Scope } from "../constants.js"
import { CLIENTS, DEFAULT_BASE_URL } from "../constants.js"
import { resolveRepoRoot } from "../memory/paths.js"
import {
  AI_MEMORY_RULE,
  DECISIONS_INDEX_SEED,
  GLOSSARY_SEED,
  LESSONS_SEED,
  MEMORY_INDEX_SEED,
  MEMORY_README_SEED,
  mergeGitignoreForMemory,
  PRDS_INDEX_SEED,
  PRODUCT_CONTEXT_SEED,
  SESSIONS_INDEX_SEED,
  SKILL_CAPTURE_ADR,
  SKILL_CAPTURE_DECISION,
  SKILL_CAPTURE_GLOSSARY,
  SKILL_CAPTURE_LESSON,
  SKILL_MEMORY_SEARCH,
} from "../memory/seed.js"
import { REPO_API_KEY_SKIP_DETAIL } from "./auth-mode.js"
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

export type RemovePathOperation = {
  type: "remove-path"
  path: string
  description: string
}

export type Operation =
  | WriteJsonOperation
  | RunOperation
  | ManualOperation
  | WriteTextOperation
  | MkdirOperation
  | RemovePathOperation

export type OperationContext = {
  cwd: string
  homeDir: string
  commandExists: (command: string) => boolean
}

export function createOperationContext(
  overrides: Partial<OperationContext> = {},
): OperationContext {
  const resolvedCwd = resolveRepoRoot(overrides.cwd ?? process.cwd())
  return {
    homeDir: homedir(),
    commandExists: () => false,
    ...overrides,
    cwd: resolvedCwd,
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

function seedText(
  path: string,
  cwd: string,
  content: string,
): WriteTextOperation {
  return {
    type: "write-text",
    path,
    description: `seed ${relativePath(path, cwd)} (only if absent)`,
    skipIfExists: true,
    content: () => content,
  }
}

export function buildMemoryArtifactOperations({
  context = createOperationContext(),
}: {
  context?: OperationContext
} = {}): Operation[] {
  const memoryRoot = resolve(context.cwd, ".ai", "memory")
  const decisions = resolve(memoryRoot, "decisions")
  const sessions = resolve(memoryRoot, "sessions")
  const prds = resolve(memoryRoot, "PRDs")
  const events = resolve(memoryRoot, "events")
  const skillsRoot = resolve(context.cwd, ".cursor", "skills")
  const rulesRoot = resolve(context.cwd, ".cursor", "rules")
  const gitignore = resolve(context.cwd, ".gitignore")

  return [
    {
      type: "mkdir",
      path: memoryRoot,
      description: `create canonical memory root at ${relativePath(memoryRoot, context.cwd)}`,
    },
    { type: "mkdir", path: decisions, description: "create decisions/" },
    { type: "mkdir", path: sessions, description: "create sessions/" },
    { type: "mkdir", path: prds, description: "create PRDs/" },
    { type: "mkdir", path: events, description: "create events/" },
    seedText(resolve(memoryRoot, "README.md"), context.cwd, MEMORY_README_SEED),
    seedText(resolve(memoryRoot, "index.md"), context.cwd, MEMORY_INDEX_SEED),
    seedText(
      resolve(memoryRoot, "lessons-learned.md"),
      context.cwd,
      LESSONS_SEED,
    ),
    seedText(resolve(memoryRoot, "glossary.md"), context.cwd, GLOSSARY_SEED),
    seedText(
      resolve(memoryRoot, "product-context.md"),
      context.cwd,
      PRODUCT_CONTEXT_SEED,
    ),
    seedText(resolve(decisions, "index.md"), context.cwd, DECISIONS_INDEX_SEED),
    seedText(resolve(sessions, "index.md"), context.cwd, SESSIONS_INDEX_SEED),
    seedText(resolve(prds, "index.md"), context.cwd, PRDS_INDEX_SEED),
    {
      type: "write-text",
      path: resolve(events, ".gitkeep"),
      description: "keep events/ in git",
      skipIfExists: true,
      content: () => "",
    },
    {
      type: "write-text",
      path: gitignore,
      description: "ensure .ai/memory/events is gitignored",
      content: (existing) => mergeGitignoreForMemory(existing ?? null),
    },
    {
      type: "mkdir",
      path: rulesRoot,
      description: "create .cursor/rules",
    },
    {
      type: "write-text",
      path: resolve(rulesRoot, "ai-memory.mdc"),
      description: "install alwaysApply ai-memory rule",
      content: () => AI_MEMORY_RULE,
    },
    { type: "mkdir", path: skillsRoot, description: "create .cursor/skills" },
    // Always refresh managed skills so upgrades pick up lifecycle/recall guidance.
    {
      type: "write-text",
      path: resolve(skillsRoot, "capture-adr", "SKILL.md"),
      description: "install capture-adr skill",
      content: () => SKILL_CAPTURE_ADR,
    },
    {
      type: "write-text",
      path: resolve(skillsRoot, "capture-lesson", "SKILL.md"),
      description: "install capture-lesson skill",
      content: () => SKILL_CAPTURE_LESSON,
    },
    {
      type: "write-text",
      path: resolve(skillsRoot, "capture-glossary", "SKILL.md"),
      description: "install capture-glossary skill",
      content: () => SKILL_CAPTURE_GLOSSARY,
    },
    {
      type: "write-text",
      path: resolve(skillsRoot, "capture-decision", "SKILL.md"),
      description: "install capture-decision skill",
      content: () => SKILL_CAPTURE_DECISION,
    },
    {
      type: "write-text",
      path: resolve(skillsRoot, "memory-search", "SKILL.md"),
      description: "install memory-search skill (Markdown + rg)",
      content: () => SKILL_MEMORY_SEARCH,
    },
  ]
}

/** Markdown-only memory init does not install an MCP server (ADR-024). */
export function buildMemoryMcpOperations(_opts: {
  clients: Client[]
  baseUrl: string
  org?: string | null
  scope: Scope
  context?: OperationContext
}): Operation[] {
  return []
}

function interpolateApiKeyEnv(client: Client, envVariable: string): string {
  switch (client) {
    case "claude":
      return `\${${envVariable}}`
    case "opencode":
      return `{env:${envVariable}}`
    case "codex":
      return envVariable
    case "cursor":
    case "vscode":
      return `\${env:${envVariable}}`
  }
}

function mcpHeaderValue(
  client: Client,
  scope: "repo" | "user",
  opts: { apiKey?: string; apiKeyEnvVariable?: string },
): string | undefined {
  if (opts.apiKeyEnvVariable) {
    return interpolateApiKeyEnv(client, opts.apiKeyEnvVariable)
  }
  if (opts.apiKey && scope === "user") return opts.apiKey
  return undefined
}

export function buildMcpOperations({
  clients,
  baseUrl,
  org,
  scope,
  memory,
  apiKey,
  apiKeyEnvVariable,
  context = createOperationContext(),
}: {
  clients: Client[]
  baseUrl: string
  org: string
  scope: Scope
  memory?: boolean
  apiKey?: string
  apiKeyEnvVariable?: string
  context?: OperationContext
}): Operation[] {
  void memory
  const requested = scopesFor(scope)
  const literalKey = Boolean(apiKey) && !apiKeyEnvVariable
  const skippedRepo = Boolean(literalKey && requested.includes("repo"))
  const scopes = literalKey
    ? requested.filter((item) => item === "user")
    : requested
  const operations = clients.flatMap((client) =>
    scopes.flatMap((singleScope) =>
      buildClientOperations({
        client,
        baseUrl,
        org,
        scope: singleScope,
        apiKey,
        apiKeyEnvVariable,
        context,
      }),
    ),
  )
  if (!skippedRepo) return operations
  return [
    {
      type: "manual",
      description: "skip repo MCP writes for API-key auth",
      detail: REPO_API_KEY_SKIP_DETAIL,
    },
    ...operations,
  ]
}

export function buildClientOperations({
  client,
  baseUrl,
  org,
  scope,
  apiKey,
  apiKeyEnvVariable,
  context = createOperationContext(),
}: {
  client: Client
  baseUrl: string
  org: string
  scope: "repo" | "user"
  apiKey?: string
  apiKeyEnvVariable?: string
  context?: OperationContext
}): Operation[] {
  if (apiKey && !apiKeyEnvVariable && scope === "repo") return []
  const url = mcpUrl({ baseUrl, org })
  const headerValue = mcpHeaderValue(client, scope, {
    apiKey,
    apiKeyEnvVariable,
  })
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
          apiKey: headerValue,
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
              ...(headerValue ? ["--header", `x-api-key: ${headerValue}`] : []),
              url,
            ],
            description: "run Claude Code MCP add command",
          },
        ]
      }
      if (scope === "user" && headerValue) {
        return [
          {
            type: "manual",
            description: "show Claude Code user MCP add command",
            detail: `Run: claude mcp add --transport http ctxpipe --scope user --header 'x-api-key: ${headerValue}' ${url}`,
          },
        ]
      }
      return [
        writeMcpServersOperation({
          path: resolve(context.cwd, ".mcp.json"),
          url,
          label: "Claude Code project",
          cwd: context.cwd,
          apiKey: headerValue,
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
          apiKey: headerValue,
        }),
      ]
    case "vscode":
      if (scope === "user") {
        return [
          {
            type: "manual",
            description: "open VS Code MCP install link",
            detail: `Open vscode:mcp/install?${encodeURIComponent(
              JSON.stringify({
                name: "ctxpipe",
                type: "http",
                url,
                ...(headerValue
                  ? { headers: { "x-api-key": headerValue } }
                  : {}),
              }),
            )}`,
          },
        ]
      }
      return [
        writeVsCodeOperation({
          path: resolve(context.cwd, ".vscode", "mcp.json"),
          url,
          cwd: context.cwd,
          apiKey: headerValue,
        }),
      ]
    case "codex":
      if (headerValue) {
        const configPath =
          scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml"
        const headerLine = apiKeyEnvVariable
          ? `env_http_headers = { "x-api-key" = "${headerValue}" }`
          : `http_headers = { "x-api-key" = "${headerValue}" }`
        return [
          {
            type: "manual",
            description: `show Codex ${scope} MCP config snippet`,
            detail: [
              `Add to ${configPath}:`,
              "",
              "[mcp_servers.ctxpipe]",
              `url = "${url}"`,
              headerLine,
            ].join("\n"),
          },
        ]
      }
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
  apiKey,
}: {
  path: string
  url: string
  label: string
  cwd: string
  apiKey?: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure ${label} MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.mcpServers) ? existing.mcpServers : {}),
      }
      servers.ctxpipe = {
        type: "streamable-http",
        url,
        ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}),
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
  apiKey,
}: {
  path: string
  url: string
  cwd: string
  apiKey?: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure OpenCode MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      const mcp: JsonObject = {
        ...(isObject(existing.mcp) ? existing.mcp : {}),
      }
      mcp.ctxpipe = {
        type: "remote",
        url,
        enabled: true,
        ...(apiKey ? { headers: { "x-api-key": apiKey }, oauth: false } : {}),
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
  apiKey,
}: {
  path: string
  url: string
  cwd: string
  apiKey?: string
}): WriteJsonOperation {
  return {
    type: "write-json",
    path,
    description: `configure VS Code MCP at ${relativePath(path, cwd)}`,
    content(existing = {}) {
      const servers: JsonObject = {
        ...(isObject(existing.servers) ? existing.servers : {}),
      }
      servers.ctxpipe = {
        type: "http",
        url,
        ...(apiKey ? { headers: { "x-api-key": apiKey } } : {}),
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

export function validateClients(
  clients: string[],
): asserts clients is Client[] {
  for (const client of clients) {
    if (!CLIENTS.includes(client as Client)) {
      throw new Error(
        `Unsupported client "${client}". Use: ${CLIENTS.join(", ")}`,
      )
    }
  }
}
