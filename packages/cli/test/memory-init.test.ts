import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")

function runMemoryInit(cwd: string, args: string[], home?: string): string {
  return execFileSync(process.execPath, [BIN, "memory", "init", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      CTXPIPE_ORG_SLUG: "",
      CTXPIPE_ORG: "",
      ...(home ? { HOME: home } : {}),
    },
  })
}

describe("memory init (end-to-end)", () => {
  it("writes ctxpipe-memory only (no remote ctxpipe) for selected clients", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-"))
    runMemoryInit(cwd, [
      "--agents",
      "cursor,claude",
      "--non-interactive",
    ])

    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command?: string; args?: string[]; url?: string }> }
    expect(cursor.mcpServers.ctxpipe).toBeUndefined()
    expect(cursor.mcpServers["ctxpipe-memory"]?.command).toBe("npx")
    expect(cursor.mcpServers["ctxpipe-memory"]?.args).toEqual(
      expect.arrayContaining(["ctxpipe", "memory", "mcp"]),
    )

    const claude = JSON.parse(
      readFileSync(join(cwd, ".mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, { command?: string; url?: string }> }
    expect(claude.mcpServers.ctxpipe).toBeUndefined()
    expect(claude.mcpServers["ctxpipe-memory"]?.command).toBe("npx")
  })

  it("creates .ai/memory and memory config without orgSlug when no --org", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-local-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"])

    expect(existsSync(join(cwd, ".ai", "memory", "README.md"))).toBe(true)
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as {
      orgSlug?: string
      memory?: { enabled: boolean; provider: string; memoryRoot: string }
    }
    expect(config.orgSlug).toBeUndefined()
    expect(config.memory?.enabled).toBe(true)
    expect(config.memory?.provider).toBe("agentmemory")
    expect(config.memory?.memoryRoot).toBe(".ai/memory")
  })

  it("stores orgSlug when --org is passed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-org-"))
    runMemoryInit(cwd, [
      "--org",
      "acme",
      "--agents",
      "cursor",
      "--non-interactive",
    ])
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as { orgSlug?: string }
    expect(config.orgSlug).toBe("acme")
  })

  it("defaults scope to repo when --scope is omitted", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-scope-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"], home)
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(true)
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false)
  })

  it("preserves existing remote MCP entries when merging", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-merge-"))
    mkdirSync(join(cwd, ".cursor"), { recursive: true })
    writeFileSync(
      join(cwd, ".cursor", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            "ctxpipe-storybook": {
              type: "streamable-http",
              url: "http://127.0.0.1:6006/mcp",
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"])
    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> }
    expect(cursor.mcpServers["ctxpipe-storybook"]).toBeDefined()
    expect(cursor.mcpServers["ctxpipe-memory"]).toBeDefined()
    expect(cursor.mcpServers.ctxpipe).toBeUndefined()
  })

  it("still accepts --yes as a deprecated alias for --non-interactive", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-yes-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--yes"])
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as { memory?: { enabled: boolean } }
    expect(config.memory?.enabled).toBe(true)
  })

  it("requires --agents in non-interactive mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-no-agents-"))
    expect(() => runMemoryInit(cwd, ["--non-interactive"])).toThrow(
      /Missing --agents/,
    )
  })
})
