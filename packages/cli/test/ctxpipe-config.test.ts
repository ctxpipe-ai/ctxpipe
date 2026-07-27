import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { DEFAULT_BASE_URL } from "../src/constants.js"
import {
  readStoredCtxpipeConfig,
  resolveCtxpipeBaseUrl,
} from "../src/auth.js"

function seedConfig(cwd: string, config: Record<string, unknown>): void {
  const dir = join(cwd, ".ctxpipe")
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "config.json"), JSON.stringify(config), "utf8")
}

describe("ctxpipe repo config", () => {
  it("resolveCtxpipeBaseUrl prefers explicit CLI override", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-config-"))
    seedConfig(cwd, { baseUrl: "https://custom.example" })
    expect(
      resolveCtxpipeBaseUrl(cwd, "https://cli.example"),
    ).toBe("https://cli.example")
  })

  it("resolveCtxpipeBaseUrl falls back to repo config when CLI uses default", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-config-"))
    seedConfig(cwd, { orgSlug: "acme", baseUrl: "https://custom.example" })
    expect(resolveCtxpipeBaseUrl(cwd, DEFAULT_BASE_URL)).toBe(
      "https://custom.example",
    )
  })

  it("readStoredCtxpipeConfig returns only orgSlug and baseUrl", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-config-"))
    seedConfig(cwd, {
      orgSlug: "acme",
      baseUrl: "https://custom.example",
      memory: { enabled: true, provider: "agentmemory" },
      mcp: { clients: ["cursor"] },
    })
    expect(readStoredCtxpipeConfig(cwd)).toEqual({
      orgSlug: "acme",
      baseUrl: "https://custom.example",
    })
  })
})
