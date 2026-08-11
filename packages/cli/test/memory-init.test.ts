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
  it("seeds Markdown layout, rule, skills, and Cursor hooks without MCP", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"])

    expect(existsSync(join(cwd, ".ai", "memory", "README.md"))).toBe(true)
    expect(existsSync(join(cwd, ".ai", "memory", "index.md"))).toBe(true)
    expect(existsSync(join(cwd, ".ai", "memory", "lessons-learned.md"))).toBe(
      true,
    )
    expect(existsSync(join(cwd, ".ai", "memory", "decisions", "index.md"))).toBe(
      true,
    )
    expect(existsSync(join(cwd, ".ai", "memory", "events", ".gitkeep"))).toBe(
      true,
    )
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-memory.mdc"))).toBe(
      true,
    )
    expect(
      existsSync(join(cwd, ".cursor", "skills", "capture-adr", "SKILL.md")),
    ).toBe(true)
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(false)

    const hooks = JSON.parse(
      readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8"),
    ) as { hooks?: Record<string, Array<{ command: string }>> }
    expect(hooks.hooks?.beforeSubmitPrompt?.[0]?.command).toMatch(
      /memory capture observe --host cursor/,
    )
    expect(hooks.hooks?.stop?.[0]?.command).toMatch(/memory capture summary/)

    const gitignore = readFileSync(join(cwd, ".gitignore"), "utf8")
    expect(gitignore).toContain(".ai/memory/events/**")
  })

  it("installs Claude capture hooks under ~/.claude when Claude is selected", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-claude-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-"))
    runMemoryInit(
      cwd,
      ["--agents", "claude", "--non-interactive"],
      home,
    )
    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.local.json"), "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string }> }>
      >
    }
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toMatch(
      /memory capture observe --host claude/,
    )
    const stopHooks = settings.hooks?.Stop?.[0]?.hooks ?? []
    expect(stopHooks).toHaveLength(1)
    expect(stopHooks[0]?.command).toMatch(
      /memory capture finalize --host claude --event Stop/,
    )
  })

  it("creates memory config without orgSlug when no --org", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-local-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"])
    const config = JSON.parse(
      readFileSync(join(cwd, ".ctxpipe", "config.json"), "utf8"),
    ) as { orgSlug?: string; memory?: unknown }
    expect(config.orgSlug).toBeUndefined()
    expect(config.memory).toBeUndefined()
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

  it("does not write user-scope Cursor hooks when scope defaults to repo", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-scope-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-"))
    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"], home)
    expect(existsSync(join(cwd, ".cursor", "hooks.json"))).toBe(true)
    expect(existsSync(join(home, ".cursor", "hooks.json"))).toBe(false)
  })

  it("does not touch unrelated MCP configs", () => {
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
    expect(cursor.mcpServers["ctxpipe-memory"]).toBeUndefined()
  })

  it("requires --agents in non-interactive mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-no-agents-"))
    expect(() => runMemoryInit(cwd, ["--non-interactive"])).toThrow(
      /Missing --agents/,
    )
  })
})
