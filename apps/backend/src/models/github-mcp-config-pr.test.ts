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
