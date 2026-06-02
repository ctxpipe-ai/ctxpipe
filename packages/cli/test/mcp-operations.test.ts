import { describe, expect, it } from "vitest"
import {
  buildClientOperations,
  buildCtxpipeConfigOperation,
  buildMemoryConfigOperation,
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

  it("memoryOnly Cursor config adds ctxpipe-memory without remote ctxpipe", () => {
    const [operation] = buildClientOperations({
      client: "cursor",
      baseUrl: "https://app.ctxpipe.ai",
      org: "local",
      scope: "repo",
      memory: true,
      memoryOnly: true,
      context,
    })

    const write = writeJson(operation)
    expect(write.content({ mcpServers: { other: { url: "x" } } })).toEqual({
      mcpServers: {
        other: { url: "x" },
        "ctxpipe-memory": {
          command: "npx",
          args: ["-y", "ctxpipe", "memory", "mcp"],
        },
      },
    })
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
})
