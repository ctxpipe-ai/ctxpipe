import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")

function runInit(cwd: string, args: string[]): string {
  return execFileSync(process.execPath, [BIN, "init", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      // The init wizard reads .ctxpipe/config.json from cwd; clear any inherited
      // env that might point elsewhere.
      CTXPIPE_ORG_SLUG: "",
      CTXPIPE_ORG: "",
    },
  })
}

describe("init --memory (end-to-end)", () => {
  it("writes ctxpipe-memory MCP entry next to ctxpipe for selected clients", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-mem-"))
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor,claude",
      "--memory",
      "--non-interactive",
    ])

    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command?: string; args?: string[]; url?: string }> }
    expect(cursor.mcpServers.ctxpipe?.url).toMatch(/orgSlug=acme/)
    expect(cursor.mcpServers["ctxpipe-memory"]?.command).toBe("npx")
    expect(cursor.mcpServers["ctxpipe-memory"]?.args).toEqual(
      expect.arrayContaining(["ctxpipe", "memory", "mcp"]),
    )

    const claude = JSON.parse(
      readFileSync(join(cwd, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command?: string; url?: string }> }
    expect(claude.mcpServers["ctxpipe-memory"]?.command).toBe("npx")
  })

  it("creates .ai/memory with a README explaining the canonical store", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-mem-"))
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor",
      "--memory",
      "--non-interactive",
    ])
    const readme = readFileSync(join(cwd, ".ai", "memory", "README.md"), "utf8")
    expect(readme.toLowerCase()).toContain("canonical")
    expect(readme).toContain(".ai/memory")
  })

  it("records orgSlug in .ctxpipe/config.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-mem-"))
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor",
      "--memory",
      "--non-interactive",
    ])
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as { orgSlug?: string; memory?: unknown; mcp?: unknown }
    expect(config.orgSlug).toBe("acme")
    expect(config.memory).toBeUndefined()
    expect(config.mcp).toBeUndefined()
  })

  it("does not touch the memory tree when --no-memory is passed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-nomem-"))
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor",
      "--no-memory",
      "--non-interactive",
    ])
    expect(existsSync(join(cwd, ".ai", "memory"))).toBe(false)
    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> }
    expect(cursor.mcpServers.ctxpipe).toBeDefined()
    expect(cursor.mcpServers["ctxpipe-memory"]).toBeUndefined()
  })

  it("preserves an existing .ai/memory/README.md", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-existing-"))
    const fs = require("node:fs") as typeof import("node:fs")
    fs.mkdirSync(join(cwd, ".ai", "memory"), { recursive: true })
    fs.writeFileSync(
      join(cwd, ".ai", "memory", "README.md"),
      "# pre-existing\n",
      "utf8",
    )
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor",
      "--memory",
      "--non-interactive",
    ])
    expect(readFileSync(join(cwd, ".ai", "memory", "README.md"), "utf8")).toBe(
      "# pre-existing\n",
    )
  })

  it("still accepts --yes as a deprecated alias for --non-interactive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-init-yes-alias-"))
    runInit(cwd, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "cursor",
      "--memory",
      "--yes",
    ])
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as { memory?: { enabled: boolean } }
    expect(config.memory).toBeUndefined()
  })
})
