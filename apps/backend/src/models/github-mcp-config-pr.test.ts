import { describe, expect, it } from "vitest"
import {
  buildOrMergeCursorClaudeMcpJson,
  buildOrMergeOpenCodeMcpJson,
  mcpStreamUrlForOrg,
} from "./github-mcp-config-pr.js"

describe("mcpStreamUrlForOrg", () => {
  it("strips trailing slash from base and appends org query", () => {
    expect(mcpStreamUrlForOrg("https://app.example/", "acme")).toBe(
      "https://app.example/mcp?orgSlug=acme",
    )
  })
})

describe("buildOrMergeCursorClaudeMcpJson", () => {
  it("creates fresh mcpServers when no existing file", () => {
    const out = buildOrMergeCursorClaudeMcpJson(
      null,
      "https://app.example/mcp?orgSlug=acme",
    )
    expect(JSON.parse(out)).toEqual({
      mcpServers: {
        ctxpipe: {
          type: "streamable-http",
          url: "https://app.example/mcp?orgSlug=acme",
        },
      },
    })
  })

  it("merges ctxpipe into existing mcpServers", () => {
    const existing = JSON.stringify({
      mcpServers: {
        other: { command: "npx", args: ["x"] },
      },
    })
    const out = buildOrMergeCursorClaudeMcpJson(
      existing,
      "https://app.example/mcp?orgSlug=acme",
    )
    expect(JSON.parse(out).mcpServers).toEqual({
      other: { command: "npx", args: ["x"] },
      ctxpipe: {
        type: "streamable-http",
        url: "https://app.example/mcp?orgSlug=acme",
      },
    })
  })
})

describe("buildOrMergeOpenCodeMcpJson", () => {
  it("creates mcp block for OpenCode", () => {
    const out = buildOrMergeOpenCodeMcpJson(
      null,
      "https://app.example/mcp?orgSlug=acme",
    )
    expect(JSON.parse(out)).toEqual({
      mcp: {
        ctxpipe: {
          type: "remote",
          url: "https://app.example/mcp?orgSlug=acme",
          enabled: true,
        },
      },
    })
  })
})
