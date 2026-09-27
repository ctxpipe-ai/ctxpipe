import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  buildOrMergeCursorClaudeMcpJson,
  buildOrMergeOpenCodeMcpJson,
  generateCtxpipeMcpConfigBranchName,
  isGithubReferenceAlreadyExists,
  isGithubReferenceUpdateFailed,
  mcpStreamUrlForOrg,
} from "./github-mcp-config-pr.js"

function httpError(status: number, message: string): Error {
  const e = new Error(message)
  e.name = "HttpError"
  ;(e as Error & { status: number }).status = status
  return e
}

describe("isGithubReferenceUpdateFailed", () => {
  it("detects Octokit 422 reference update failed", () => {
    expect(
      isGithubReferenceUpdateFailed(
        httpError(
          422,
          "Reference update failed - https://docs.github.com/rest/git/refs#create-a-reference",
        ),
      ),
    ).toBe(true)
  })

  it("rejects non-422 or other messages", () => {
    expect(isGithubReferenceUpdateFailed(httpError(422, "Not found"))).toBe(
      false,
    )
    expect(
      isGithubReferenceUpdateFailed(
        httpError(
          403,
          "Reference update failed - https://docs.github.com/rest/git/refs#create-a-reference",
        ),
      ),
    ).toBe(false)
  })
})

describe("isGithubReferenceAlreadyExists", () => {
  it("detects already-exists style 422", () => {
    expect(
      isGithubReferenceAlreadyExists(
        httpError(422, "Reference already exists"),
      ),
    ).toBe(true)
  })
})

describe("generateCtxpipeMcpConfigBranchName", () => {
  it("returns distinct names suitable for refs/heads/ (batch PRs)", () => {
    const names = new Set<string>()
    for (let i = 0; i < 50; i += 1) {
      names.add(generateCtxpipeMcpConfigBranchName())
    }
    expect(names.size).toBe(50)
    for (const n of names) {
      expect(n).toMatch(/^ctxpipe\/mcp-config-[0-9a-z]+-[0-9a-z]+$/)
    }
  })
})

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
          type: "http",
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
        type: "http",
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

describe("MCP install distributions stay OAuth-only", () => {
  it("does not put API-key headers or secrets in GitHub PR MCP JSON", () => {
    const cursor = buildOrMergeCursorClaudeMcpJson(
      null,
      "https://app.example/mcp?orgSlug=acme",
    )
    const opencode = buildOrMergeOpenCodeMcpJson(
      null,
      "https://app.example/mcp?orgSlug=acme",
    )
    for (const json of [cursor, opencode]) {
      expect(json).not.toContain("x-api-key")
      expect(json).not.toContain("CTXPIPE_API_KEY")
      expect(json).not.toMatch(/"headers"/)
    }
  })

  it("keeps the Claude plugin MCP URL OAuth-only with no API-key header", () => {
    const pluginPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../plugins/ctxpipe/.mcp.json",
    )
    const plugin = JSON.parse(readFileSync(pluginPath, "utf8")) as {
      mcpServers: {
        ctxpipe?: { url?: string; headers?: Record<string, string> }
      }
    }
    expect(plugin.mcpServers.ctxpipe?.url).toBe("https://app.ctxpipe.ai/mcp")
    expect(plugin.mcpServers.ctxpipe?.headers).toBeUndefined()
    expect(JSON.stringify(plugin)).not.toContain("x-api-key")
    expect(JSON.stringify(plugin)).not.toContain("CTXPIPE_API_KEY")
  })
})
