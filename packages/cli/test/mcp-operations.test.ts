import { describe, expect, it } from "vitest"

import {
  buildClientOperations,
  buildCtxpipeConfigOperation,
  buildMcpOperations,
  buildMemoryConfigOperation,
  createOperationContext,
  type OperationContext,
  validateAuthMode,
  validateClients,
  validateScope,
  type WriteJsonOperation,
} from "../src/mcp/mcp-operations.js"

const context: OperationContext = createOperationContext({
  cwd: "/repo",
  homeDir: "/home/alex",
  commandExists: (command) => command === "claude",
})

const apiKeyAuth = "api-key" as const

function writeJson(operation: unknown): WriteJsonOperation {
  expect(operation).toMatchObject({ type: "write-json" })
  return operation as WriteJsonOperation
}

describe("MCP operation builders", () => {
  it("writes no repo ctxpipe config for the default SaaS base URL", () => {
    expect(
      buildCtxpipeConfigOperation({
        baseUrl: "https://app.ctxpipe.ai/",
        context,
      }),
    ).toBeNull()
  })

  it("builds repo ctxpipe config with non-default baseUrl", () => {
    const operation = buildCtxpipeConfigOperation({
      baseUrl: "https://my.ctxpipe.example",
      context,
    })

    expect(operation?.path).toBe("/repo/.ctxpipe/config.json")
    expect(operation?.content({ keep: true })).toEqual({
      baseUrl: "https://my.ctxpipe.example",
    })
  })

  it("writes Cursor repo MCP config", () => {
    const [operation] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      context,
    })

    const write = writeJson(operation)
    expect(write.path).toBe("/repo/.cursor/mcp.json")
    expect(write.content({ mcpServers: { other: { url: "x" } } })).toEqual({
      mcpServers: {
        other: { url: "x" },
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
        },
      },
    })
  })

  it("uses Claude user scope when the Claude CLI is available", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      context,
    })

    expect(operation).toEqual({
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
        "https://app.ctxpipe.ai/mcp",
      ],
      description: "run Claude Code MCP add command",
    })
  })

  it("falls back to project Claude config when the Claude CLI is unavailable", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      context: createOperationContext({
        cwd: "/repo",
        homeDir: "/home/alex",
        commandExists: () => false,
      }),
    })

    expect(writeJson(operation).path).toBe("/repo/.mcp.json")
  })

  it("expands both scope into repo and user operations", () => {
    const operations = buildMcpOperations({
      clients: ["opencode"],
      baseUrl: "https://app.ctxpipe.ai",
      scope: "both",
      context,
    })

    expect(operations.map((operation) => writeJson(operation).path)).toEqual([
      "/repo/opencode.json",
      "/home/alex/.config/opencode/opencode.json",
    ])
  })

  it("returns manual instructions for user-scoped VS Code setup", () => {
    const [operation] = buildClientOperations({
      client: "vscode",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      context,
    })

    expect(operation).toMatchObject({
      type: "manual",
      description: "open VS Code MCP install link",
    })
    expect(operation?.type === "manual" ? operation.detail : "").toContain(
      "vscode:mcp/install?",
    )
  })

  it("validates scope, client names, and auth modes", () => {
    expect(() => validateScope("global")).toThrow("--scope must be one of")
    expect(() => validateClients(["cursor", "bad"])).toThrow(
      'Unsupported client "bad"',
    )
    expect(() => validateAuthMode("bearer")).toThrow("--auth must be one of")
  })

  it("writes no memory config for the default base URL", () => {
    expect(
      buildMemoryConfigOperation({
        baseUrl: "https://app.ctxpipe.ai",
        context,
      }),
    ).toBeNull()
  })

  it("buildMemoryConfigOperation ignores an existing orgSlug", () => {
    const operation = buildMemoryConfigOperation({
      baseUrl: "https://my.ctxpipe.example",
      context,
    })
    expect(operation?.content({ orgSlug: "old-org" })).toEqual({
      baseUrl: "https://my.ctxpipe.example",
    })
  })

  it("adds interpolated x-api-key headers on user and repo Cursor config", () => {
    const [userOp] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context,
    })
    const [repoOp] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      auth: apiKeyAuth,
      context,
    })

    const header = { "x-api-key": `\${env:CTXPIPE_API_KEY}` }
    expect(writeJson(userOp).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
          headers: header,
        },
      },
    })
    expect(writeJson(repoOp).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
          headers: header,
        },
      },
    })
  })

  it("writes OpenCode user and repo config with interpolated headers and oauth disabled", () => {
    const operations = buildMcpOperations({
      clients: ["opencode"],
      baseUrl: "https://app.ctxpipe.ai",
      scope: "both",
      auth: apiKeyAuth,
      context,
    })

    expect(operations.map((operation) => writeJson(operation).path)).toEqual([
      "/repo/opencode.json",
      "/home/alex/.config/opencode/opencode.json",
    ])
    const expected = {
      mcp: {
        ctxpipe: {
          type: "remote",
          url: "https://app.ctxpipe.ai/mcp",
          enabled: true,
          headers: { "x-api-key": "{env:CTXPIPE_API_KEY}" },
          oauth: false,
        },
      },
    }
    expect(writeJson(operations[0]).content({})).toEqual(expected)
    expect(writeJson(operations[1]).content({})).toEqual(expected)
  })

  it("passes interpolated x-api-key to Claude user CLI and does not write project .mcp.json", () => {
    const [withCli] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context,
    })
    const [withoutCli] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context: createOperationContext({
        cwd: "/repo",
        homeDir: "/home/alex",
        commandExists: () => false,
      }),
    })

    expect(withCli).toEqual({
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
        "https://app.ctxpipe.ai/mcp",
        "--header",
        `x-api-key: \${CTXPIPE_API_KEY}`,
      ],
      description: "run Claude Code MCP add command",
    })
    expect(withoutCli).toEqual({
      type: "manual",
      description: "show Claude Code user MCP add command",
      detail: `Run: claude mcp add --transport http ctxpipe --scope user https://app.ctxpipe.ai/mcp --header 'x-api-key: \${CTXPIPE_API_KEY}'`,
    })
  })

  it("prints Claude user env-header commands with single-quoted interpolants", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context: createOperationContext({
        cwd: "/repo",
        homeDir: "/home/alex",
        commandExists: () => false,
      }),
    })

    expect(operation).toMatchObject({
      type: "manual",
      description: "show Claude Code user MCP add command",
    })
    const detail = operation?.type === "manual" ? operation.detail : ""
    expect(detail).toBe(
      `Run: claude mcp add --transport http ctxpipe --scope user https://app.ctxpipe.ai/mcp --header 'x-api-key: \${CTXPIPE_API_KEY}'`,
    )
    expect(detail).not.toContain('--header "x-api-key:')
  })

  it("includes interpolated headers in the VS Code user install payload", () => {
    const [operation] = buildClientOperations({
      client: "vscode",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context,
    })

    expect(operation?.type).toBe("manual")
    const detail = operation?.type === "manual" ? operation.detail : ""
    const encoded = detail.split("vscode:mcp/install?")[1] ?? ""
    const payload = JSON.parse(decodeURIComponent(encoded)) as {
      headers?: { "x-api-key"?: string }
    }
    expect(payload.headers?.["x-api-key"]).toBe(`\${env:CTXPIPE_API_KEY}`)
  })

  it("prints a Codex user-config snippet instead of running mcp add with an API key", () => {
    const [operation] = buildClientOperations({
      client: "codex",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context: createOperationContext({
        cwd: "/repo",
        homeDir: "/home/alex",
        commandExists: () => true,
      }),
    })

    expect(operation).toMatchObject({
      type: "manual",
      description: "show Codex user MCP config snippet",
    })
    expect(operation?.type === "manual" ? operation.detail : "").toContain(
      'env_http_headers = { "x-api-key" = "CTXPIPE_API_KEY" }',
    )
  })

  it("writes env-variable API-key references to repo and user Cursor config", () => {
    const operations = buildMcpOperations({
      clients: ["cursor"],
      baseUrl: "https://app.ctxpipe.ai",
      scope: "both",
      auth: apiKeyAuth,
      context,
    })

    expect(operations.map((operation) => writeJson(operation).path)).toEqual([
      "/repo/.cursor/mcp.json",
      "/home/alex/.cursor/mcp.json",
    ])
    expect(writeJson(operations[0]).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
          headers: { "x-api-key": `\${env:CTXPIPE_API_KEY}` },
        },
      },
    })
  })

  it("writes OpenCode env interpolation and oauth disabled for repo scope", () => {
    const [operation] = buildClientOperations({
      client: "opencode",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      auth: apiKeyAuth,
      context,
    })

    expect(writeJson(operation).content({})).toEqual({
      mcp: {
        ctxpipe: {
          type: "remote",
          url: "https://app.ctxpipe.ai/mcp",
          enabled: true,
          headers: { "x-api-key": "{env:CTXPIPE_API_KEY}" },
          oauth: false,
        },
      },
    })
  })

  it("writes Claude project config with env-var header interpolation", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      auth: apiKeyAuth,
      context,
    })

    expect(writeJson(operation).path).toBe("/repo/.mcp.json")
    expect(writeJson(operation).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
          headers: { "x-api-key": `\${CTXPIPE_API_KEY}` },
        },
      },
    })
  })

  it("writes VS Code repo config with env-var headers", () => {
    const [operation] = buildClientOperations({
      client: "vscode",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      auth: apiKeyAuth,
      context,
    })

    expect(writeJson(operation).path).toBe("/repo/.vscode/mcp.json")
    expect(writeJson(operation).content({})).toEqual({
      servers: {
        ctxpipe: {
          type: "http",
          url: "https://app.ctxpipe.ai/mcp",
          headers: { "x-api-key": `\${env:CTXPIPE_API_KEY}` },
        },
      },
    })
  })

  it("prints Codex env_http_headers with the variable name", () => {
    const [operation] = buildClientOperations({
      client: "codex",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "repo",
      auth: apiKeyAuth,
      context,
    })

    expect(operation).toMatchObject({
      type: "manual",
      description: "show Codex repo MCP config snippet",
    })
    const detail = operation?.type === "manual" ? operation.detail : ""
    expect(detail).toContain("Add to .codex/config.toml:")
    expect(detail).not.toContain("Add to ~/.codex/config.toml:")
    expect(detail).toContain(
      'env_http_headers = { "x-api-key" = "CTXPIPE_API_KEY" }',
    )
  })

  it("prints Codex user env_http_headers against ~/.codex/config.toml", () => {
    const [operation] = buildClientOperations({
      client: "codex",
      baseUrl: "https://app.ctxpipe.ai",
      scope: "user",
      auth: apiKeyAuth,
      context,
    })

    expect(operation).toMatchObject({
      type: "manual",
      description: "show Codex user MCP config snippet",
    })
    const detail = operation?.type === "manual" ? operation.detail : ""
    expect(detail).toContain("Add to ~/.codex/config.toml:")
    expect(detail).not.toContain("Add to .codex/config.toml:")
    expect(detail).toContain(
      'env_http_headers = { "x-api-key" = "CTXPIPE_API_KEY" }',
    )
  })

  it("emits distinct Codex repo and user env snippets for both scope", () => {
    const operations = buildMcpOperations({
      clients: ["codex"],
      baseUrl: "https://app.ctxpipe.ai",
      scope: "both",
      auth: apiKeyAuth,
      context,
    })

    expect(operations).toHaveLength(2)
    const details = operations.map((operation) =>
      operation.type === "manual" ? operation.detail : "",
    )
    expect(details[0]).toContain("Add to .codex/config.toml:")
    expect(details[1]).toContain("Add to ~/.codex/config.toml:")
    expect(details[0]).not.toEqual(details[1])
    for (const detail of details) {
      expect(detail).toContain(
        'env_http_headers = { "x-api-key" = "CTXPIPE_API_KEY" }',
      )
    }
  })
})
