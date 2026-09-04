import { describe, expect, it } from "vitest"
import {
  buildClientOperations,
  buildCtxpipeConfigOperation,
  buildMemoryConfigOperation,
  buildMemoryMcpOperations,
  buildMcpOperations,
  createOperationContext,
  validateClients,
  validateScope,
  type OperationContext,
  type WriteJsonOperation,
} from "../src/mcp/mcp-operations.js"

const context: OperationContext = createOperationContext({
  cwd: "/repo",
  homeDir: "/home/alex",
  commandExists: (command) => command === "claude",
})

function writeJson(operation: unknown): WriteJsonOperation {
  expect(operation).toMatchObject({ type: "write-json" })
  return operation as WriteJsonOperation
}

describe("MCP operation builders", () => {
  it("builds minimal repo ctxpipe config for default SaaS base URL", () => {
    const operation = buildCtxpipeConfigOperation({
      baseUrl: "https://app.ctxpipe.ai/",
      org: "acme",
      context,
    })

    expect(operation.path).toBe("/repo/.ctxpipe/config.json")
    expect(
      operation.content({
        keep: true,
        mcp: { previous: true },
        memory: { enabled: true },
      }),
    ).toEqual({
      orgSlug: "acme",
    })
  })

  it("builds repo ctxpipe config with non-default baseUrl", () => {
    const operation = buildCtxpipeConfigOperation({
      baseUrl: "https://my.ctxpipe.example",
      org: "acme",
      context,
    })

    expect(operation.content({})).toEqual({
      orgSlug: "acme",
      baseUrl: "https://my.ctxpipe.example",
    })
  })

  it("writes Cursor repo MCP config", () => {
    const [operation] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "repo",
      context,
    })

    const write = writeJson(operation)
    expect(write.path).toBe("/repo/.cursor/mcp.json")
    expect(write.content({ mcpServers: { other: { url: "x" } } })).toEqual({
      mcpServers: {
        other: { url: "x" },
        ctxpipe: {
          type: "streamable-http",
          url: "https://app.ctxpipe.ai/mcp?orgSlug=acme",
        },
      },
    })
  })

  it("uses Claude user scope when the Claude CLI is available", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
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
        "https://app.ctxpipe.ai/mcp?orgSlug=acme",
      ],
      description: "run Claude Code MCP add command",
    })
  })

  it("falls back to project Claude config when the Claude CLI is unavailable", () => {
    const [operation] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
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
      org: "acme",
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
      org: "acme",
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

  it("validates scope and client names", () => {
    expect(() => validateScope("global")).toThrow("--scope must be one of")
    expect(() => validateClients(["cursor", "bad"])).toThrow(
      'Unsupported client "bad"',
    )
  })

  it("does not build MCP operations for Markdown-only memory", () => {
    const operations = buildMemoryMcpOperations({
      clients: ["cursor"],
      baseUrl: "https://app.ctxpipe.ai",
      org: null,
      scope: "repo",
      context,
    })
    expect(operations).toEqual([])
  })

  it("buildMemoryConfigOperation omits orgSlug when org is not provided", () => {
    const operation = buildMemoryConfigOperation({
      baseUrl: "https://app.ctxpipe.ai",
      context,
    })
    const result = operation.content({}) as {
      orgSlug?: string
      memory?: { enabled: boolean }
    }
    expect(result).toEqual({})
  })

  it("buildMemoryConfigOperation writes orgSlug for known org", () => {
    const operation = buildMemoryConfigOperation({
      org: "acme",
      baseUrl: "https://app.ctxpipe.ai",
      context,
    })
    expect(operation.content({})).toEqual({ orgSlug: "acme" })
  })

  it("buildMemoryConfigOperation preserves existing orgSlug when org is not provided", () => {
    const operation = buildMemoryConfigOperation({
      baseUrl: "https://app.ctxpipe.ai",
      context,
    })
    expect(operation.content({ orgSlug: "acme" })).toEqual({ orgSlug: "acme" })
  })

  it("buildMemoryConfigOperation preserves non-default baseUrl from existing config", () => {
    const operation = buildMemoryConfigOperation({
      org: "acme",
      baseUrl: "https://app.ctxpipe.ai",
      context,
    })
    expect(
      operation.content({
        baseUrl: "https://custom.example",
        mcp: { url: "https://custom.example/mcp?orgSlug=acme" },
      }),
    ).toEqual({
      orgSlug: "acme",
      baseUrl: "https://custom.example",
    })
  })

  it("adds x-api-key headers only on user-scope Cursor config", () => {
    const [userOp] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "user",
      apiKey: "ctxp_secret",
      context,
    })
    const [repoOp] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "repo",
      context,
    })

    expect(writeJson(userOp).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "streamable-http",
          url: "https://app.ctxpipe.ai/mcp?orgSlug=acme",
          headers: { "x-api-key": "ctxp_secret" },
        },
      },
    })
    expect(writeJson(repoOp).content({})).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "streamable-http",
          url: "https://app.ctxpipe.ai/mcp?orgSlug=acme",
        },
      },
    })
  })

  it("skips repo MCP writes when an API key is present", () => {
    const operations = buildMcpOperations({
      clients: ["cursor", "opencode"],
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "repo",
      apiKey: "ctxp_secret",
      context,
    })

    expect(operations).toEqual([
      {
        type: "manual",
        description: "skip repo MCP writes for API-key auth",
        detail: expect.stringContaining("must not land in committed files"),
      },
    ])
  })

  it("writes OpenCode user config with headers and oauth disabled", () => {
    const operations = buildMcpOperations({
      clients: ["opencode"],
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "both",
      apiKey: "ctxp_secret",
      context,
    })

    expect(operations[0]).toMatchObject({
      type: "manual",
      description: "skip repo MCP writes for API-key auth",
    })
    const write = writeJson(operations[1])
    expect(write.path).toBe("/home/alex/.config/opencode/opencode.json")
    expect(write.content({})).toEqual({
      mcp: {
        ctxpipe: {
          type: "remote",
          url: "https://app.ctxpipe.ai/mcp?orgSlug=acme",
          enabled: true,
          headers: { "x-api-key": "ctxp_secret" },
          oauth: false,
        },
      },
    })
  })

  it("passes x-api-key to Claude user CLI and does not write project .mcp.json", () => {
    const [withCli] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "user",
      apiKey: "ctxp_secret",
      context,
    })
    const [withoutCli] = buildClientOperations({
      client: "claude",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "user",
      apiKey: "ctxp_secret",
      context: createOperationContext({
        cwd: "/repo",
        homeDir: "/home/alex",
        commandExists: () => false,
      }),
    })

    expect(withCli).toMatchObject({
      type: "run",
      command: expect.arrayContaining([
        "--header",
        "x-api-key: ctxp_secret",
      ]),
    })
    expect(withoutCli).toMatchObject({
      type: "manual",
      description: "show Claude Code user MCP add command",
    })
    expect(withoutCli?.type === "manual" ? withoutCli.detail : "").toContain(
      '--header "x-api-key: ctxp_secret"',
    )
  })

  it("includes headers in the VS Code user install payload", () => {
    const [operation] = buildClientOperations({
      client: "vscode",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "user",
      apiKey: "ctxp_secret",
      context,
    })

    expect(operation?.type).toBe("manual")
    const detail = operation?.type === "manual" ? operation.detail : ""
    const encoded = detail.split("vscode:mcp/install?")[1] ?? ""
    const payload = JSON.parse(decodeURIComponent(encoded)) as {
      headers?: { "x-api-key"?: string }
    }
    expect(payload.headers?.["x-api-key"]).toBe("ctxp_secret")
  })

  it("prints a Codex user-config snippet instead of running mcp add with an API key", () => {
    const [operation] = buildClientOperations({
      client: "codex",
      baseUrl: "https://app.ctxpipe.ai",
      org: "acme",
      scope: "user",
      apiKey: "ctxp_secret",
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
      'http_headers = { "x-api-key" = "ctxp_secret" }',
    )
  })
})
