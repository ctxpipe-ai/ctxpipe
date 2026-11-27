import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
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
    expect(
      existsSync(join(cwd, ".ai", "memory", "decisions", "index.md")),
    ).toBe(true)
    expect(existsSync(join(cwd, ".ai", "memory", "events", ".gitkeep"))).toBe(
      true,
    )
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-memory.mdc"))).toBe(
      true,
    )
    const memoryRule = readFileSync(
      join(cwd, ".cursor", "rules", "ai-memory.mdc"),
      "utf8",
    )
    expect(memoryRule).toMatch(/rg -i/)
    expect(memoryRule).toContain("## User reply")
    expect(memoryRule).toContain(
      "one short sentence naming only what was learned",
    )
    expect(
      existsSync(join(cwd, ".cursor", "skills", "capture-adr", "SKILL.md")),
    ).toBe(true)
    expect(
      existsSync(join(cwd, ".cursor", "skills", "memory-search", "SKILL.md")),
    ).toBe(true)
    expect(
      readFileSync(
        join(cwd, ".cursor", "skills", "memory-search", "SKILL.md"),
        "utf8",
      ),
    ).toMatch(/!events\/\*\*/)
    expect(existsSync(join(cwd, ".cursor", "mcp.json"))).toBe(false)

    const hooks = JSON.parse(
      readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{ command: string; loop_limit?: number | null }>
      >
    }
    expect(hooks.hooks?.beforeSubmitPrompt?.[0]?.command).toMatch(
      /memory capture observe --host cursor/,
    )
    expect(hooks.hooks?.stop?.[0]?.command).toMatch(
      /memory capture finalize --host cursor --event stop/,
    )
    expect(hooks.hooks?.stop?.[0]?.loop_limit).toBe(1)
    expect(hooks.hooks?.afterFileEdit).toBeUndefined()
    expect(hooks.hooks?.postToolUse).toBeUndefined()

    const gitignore = readFileSync(join(cwd, ".gitignore"), "utf8")
    expect(gitignore).toContain(".ai/memory/events/**")
  })

  it("installs Claude project hooks under .claude/settings.json for repo scope", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-claude-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-"))
    runMemoryInit(cwd, ["--agents", "claude", "--non-interactive"], home)
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false)
    const settings = JSON.parse(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf8"),
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
    expect(settings.hooks?.PostToolUse).toBeUndefined()
  })

  it("strips leftover Claude PostToolUse capture hooks on re-init", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-claude-strip-"))
    mkdirSync(join(cwd, ".claude"), { recursive: true })
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify(
        {
          hooks: {
            PostToolUse: [
              {
                hooks: [
                  {
                    type: "command",
                    command:
                      "npx -y ctxpipe memory capture observe --host claude --event PostToolUse",
                  },
                  {
                    type: "command",
                    command: "echo sibling-post-tool",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    runMemoryInit(cwd, ["--agents", "claude", "--non-interactive"])
    const settings = JSON.parse(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string }> }>
      >
    }
    const leftover = settings.hooks?.PostToolUse?.[0]?.hooks ?? []
    expect(leftover).toHaveLength(1)
    expect(leftover[0]?.command).toBe("echo sibling-post-tool")
    expect(JSON.stringify(settings.hooks?.PostToolUse)).not.toContain(
      "ctxpipe memory capture",
    )
  })

  it("installs Claude user hooks under ~/.claude/settings.json for user scope", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-claude-user-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-"))
    runMemoryInit(
      cwd,
      ["--agents", "claude", "--scope", "user", "--non-interactive"],
      home,
    )
    expect(existsSync(join(cwd, ".claude", "settings.json"))).toBe(false)
    const settings = JSON.parse(
      readFileSync(join(home, ".claude", "settings.json"), "utf8"),
    ) as {
      hooks?: Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string }> }>
      >
    }
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toMatch(
      /memory capture finalize --host claude --event Stop/,
    )
    expect(
      readFileSync(join(home, ".claude", "rules", "ai-memory.md"), "utf8"),
    ).toContain("## Commit and share")
    expect(
      existsSync(join(home, ".claude", "skills", "capture-lesson", "SKILL.md")),
    ).toBe(true)
    expect(existsSync(join(cwd, ".claude", "rules"))).toBe(false)
  })

  it("gives Claude Code the memory rule and skills without creating CLAUDE.md", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-claude-rule-"))
    runMemoryInit(cwd, ["--agents", "claude", "--non-interactive"])

    // Claude Code loads .claude/rules every session; a CLAUDE.md would stop it
    // falling back to AGENTS.md.
    const rule = readFileSync(
      join(cwd, ".claude", "rules", "ai-memory.md"),
      "utf8",
    )
    expect(rule.startsWith("# Local memory")).toBe(true)
    expect(rule).toContain("## Commit and share")
    for (const skill of [
      "capture-adr",
      "capture-lesson",
      "capture-glossary",
      "capture-decision",
      "memory-search",
    ]) {
      expect(
        existsSync(join(cwd, ".claude", "skills", skill, "SKILL.md")),
        skill,
      ).toBe(true)
    }
    expect(
      readFileSync(
        join(cwd, ".claude", "skills", "capture-lesson", "SKILL.md"),
        "utf8",
      ),
    ).toContain("Include the `.ai/memory/` change in the commit")
    expect(existsSync(join(cwd, "CLAUDE.md"))).toBe(false)
    expect(existsSync(join(cwd, ".claude", "CLAUDE.md"))).toBe(false)
  })

  it("installs Codex, OpenCode, and VS Code capture artifacts (not manual-only)", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-five-"))
    runMemoryInit(cwd, [
      "--agents",
      "codex,opencode,vscode",
      "--non-interactive",
    ])

    const codexToml = readFileSync(join(cwd, ".codex", "config.toml"), "utf8")
    expect(codexToml).toContain("[[hooks.Stop]]")
    expect(codexToml).toMatch(
      /memory capture finalize --host codex --event Stop/,
    )
    expect(readFileSync(join(cwd, "AGENTS.md"), "utf8")).toContain(
      "ctxpipe-memory-capture",
    )

    expect(existsSync(join(cwd, ".opencode", "memory-capture.md"))).toBe(true)
    const opencode = JSON.parse(
      readFileSync(join(cwd, "opencode.json"), "utf8"),
    ) as { instructions?: string[] }
    expect(opencode.instructions).toContain(".opencode/memory-capture.md")

    expect(existsSync(join(cwd, ".github", "copilot-instructions.md"))).toBe(
      true,
    )
    const vscodeModular = join(
      cwd,
      ".github",
      "instructions",
      "ctxpipe-memory.instructions.md",
    )
    expect(existsSync(vscodeModular)).toBe(true)
    expect(readFileSync(vscodeModular, "utf8")).toMatch(/applyTo:\s*"\*\*"/)

    const vscodeHooks = JSON.parse(
      readFileSync(
        join(cwd, ".github", "hooks", "ctxpipe-memory.json"),
        "utf8",
      ),
    ) as { hooks: Record<string, Array<{ type: string; command: string }>> }
    expect(vscodeHooks.hooks.UserPromptSubmit?.[0]?.command).toMatch(
      /memory capture observe --host vscode --event UserPromptSubmit/,
    )
    expect(vscodeHooks.hooks.Stop?.[0]?.command).toMatch(
      /memory capture finalize --host vscode --event Stop/,
    )

    expect(
      readFileSync(
        join(cwd, ".opencode", "plugins", "ctxpipe-memory.js"),
        "utf8",
      ),
    ).toContain("session.idle")
  })

  it("installs discoverable VS Code / OpenCode user-scope instruction paths", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-user-five-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-home-five-"))
    runMemoryInit(
      cwd,
      ["--agents", "vscode,opencode", "--scope", "user", "--non-interactive"],
      home,
    )
    expect(existsSync(join(home, ".copilot", "copilot-instructions.md"))).toBe(
      true,
    )
    expect(
      readFileSync(join(home, ".copilot", "copilot-instructions.md"), "utf8"),
    ).toMatch(/--host vscode/)
    const vscodeUserInstructions = join(
      home,
      ".copilot",
      "instructions",
      "ctxpipe-memory.instructions.md",
    )
    expect(existsSync(vscodeUserInstructions)).toBe(true)
    expect(readFileSync(vscodeUserInstructions, "utf8")).toMatch(
      /applyTo:\s*"\*\*"/,
    )
    expect(readFileSync(vscodeUserInstructions, "utf8")).toMatch(
      /--host vscode/,
    )
    expect(
      existsSync(join(home, ".config", "opencode", "memory-capture.md")),
    ).toBe(true)
    const opencode = JSON.parse(
      readFileSync(join(home, ".config", "opencode", "opencode.json"), "utf8"),
    ) as { instructions?: string[] }
    expect(opencode.instructions).toContain("memory-capture.md")
    expect(
      existsSync(join(home, ".copilot", "hooks", "ctxpipe-memory.json")),
    ).toBe(true)
    expect(
      existsSync(
        join(home, ".config", "opencode", "plugins", "ctxpipe-memory.js"),
      ),
    ).toBe(true)
    expect(existsSync(join(cwd, ".github", "hooks"))).toBe(false)
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

  it("upgrades a legacy fixture: strips ctxpipe-memory, migrates patterns, removes retired skills", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-upgrade-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-upgrade-home-"))
    mkdirSync(join(cwd, ".cursor", "skills", "memory-sync"), {
      recursive: true,
    })
    mkdirSync(join(cwd, ".cursor", "rules"), { recursive: true })
    mkdirSync(join(cwd, ".ai", "memory", "decisions"), { recursive: true })
    mkdirSync(join(cwd, ".vscode"), { recursive: true })
    mkdirSync(join(home, ".claude"), { recursive: true })
    writeFileSync(
      join(cwd, ".cursor", "mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            ctxpipe: {
              type: "streamable-http",
              url: "https://app.ctxpipe.ai/mcp",
            },
            "ctxpipe-memory": {
              command: "npx",
              args: ["-y", "ctxpipe", "memory", "mcp"],
            },
            other: { url: "https://example.com" },
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    writeFileSync(
      join(cwd, ".vscode", "mcp.json"),
      JSON.stringify(
        {
          servers: {
            "ctxpipe-memory": {
              command: "npx",
              args: ["-y", "ctxpipe", "memory", "mcp"],
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    writeFileSync(
      join(home, ".claude", "settings.local.json"),
      JSON.stringify(
        {
          hooks: {
            Stop: [
              {
                hooks: [
                  {
                    type: "command",
                    command: "npx -y ctxpipe memory hook claude-stop",
                  },
                ],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    writeFileSync(
      join(cwd, ".cursor", "skills", "memory-sync", "SKILL.md"),
      "# legacy\n",
      "utf8",
    )
    writeFileSync(
      join(cwd, ".cursor", "rules", "project-memory.mdc"),
      "legacy rule\n",
      "utf8",
    )
    writeFileSync(
      join(cwd, ".ai", "memory", "patterns.md"),
      "## Old pattern\n\n- Always migrate on init\n",
      "utf8",
    )
    writeFileSync(
      join(cwd, ".ai", "memory", "decisions", "README.md"),
      "# old\n",
      "utf8",
    )
    writeFileSync(
      join(cwd, ".ai", "memory", "README.md"),
      "# Legacy\n\nUse AgentMemory via ctxpipe-memory MCP.\n",
      "utf8",
    )
    mkdirSync(join(cwd, ".cursor", "skills", "memory-search"), {
      recursive: true,
    })
    writeFileSync(
      join(cwd, ".cursor", "skills", "memory-search", "SKILL.md"),
      "# old search\n\nUse AgentMemory embeddings.\n",
      "utf8",
    )
    mkdirSync(join(home, ".codex"), { recursive: true })
    writeFileSync(
      join(home, ".codex", "config.toml"),
      `[mcp_servers.ctxpipe-memory]
command = "npx"
args = ["-y", "ctxpipe", "memory", "mcp"]

[other]
enabled = true
`,
      "utf8",
    )

    runMemoryInit(
      cwd,
      ["--agents", "cursor,claude,codex", "--non-interactive"],
      home,
    )

    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, unknown> }
    expect(cursor.mcpServers["ctxpipe-memory"]).toBeUndefined()
    expect(cursor.mcpServers.ctxpipe).toBeDefined()
    expect(cursor.mcpServers.other).toBeDefined()
    const vscode = JSON.parse(
      readFileSync(join(cwd, ".vscode", "mcp.json"), "utf8"),
    ) as { servers: Record<string, unknown> }
    expect(vscode.servers["ctxpipe-memory"]).toBeUndefined()
    const claude = JSON.parse(
      readFileSync(join(home, ".claude", "settings.local.json"), "utf8"),
    ) as { hooks?: { Stop?: unknown[] } }
    const stop = JSON.stringify(claude.hooks?.Stop ?? [])
    expect(stop).not.toContain("memory hook")
    expect(existsSync(join(cwd, ".cursor", "skills", "memory-sync"))).toBe(
      false,
    )
    expect(
      existsSync(join(cwd, ".cursor", "rules", "project-memory.mdc")),
    ).toBe(false)
    expect(existsSync(join(cwd, ".ai", "memory", "patterns.md"))).toBe(false)
    expect(
      existsSync(join(cwd, ".ai", "memory", "decisions", "README.md")),
    ).toBe(false)
    const lessons = readFileSync(
      join(cwd, ".ai", "memory", "lessons-learned.md"),
      "utf8",
    )
    expect(lessons).toContain("Migrated from former `patterns.md`")
    expect(lessons).toContain("Always migrate on init")
    expect(existsSync(join(cwd, ".cursor", "rules", "ai-memory.mdc"))).toBe(
      true,
    )
    const memoryReadme = readFileSync(
      join(cwd, ".ai", "memory", "README.md"),
      "utf8",
    )
    expect(memoryReadme).not.toMatch(/AgentMemory|ctxpipe-memory/i)
    expect(memoryReadme).toContain("index.md")
    expect(memoryReadme).toContain("capture skills")
    const searchSkill = readFileSync(
      join(cwd, ".cursor", "skills", "memory-search", "SKILL.md"),
      "utf8",
    )
    expect(searchSkill).toContain("No embeddings daemon")
    expect(searchSkill).not.toMatch(/Use AgentMemory embeddings/)
    const captureLesson = readFileSync(
      join(cwd, ".cursor", "skills", "capture-lesson", "SKILL.md"),
      "utf8",
    )
    expect(captureLesson).toContain("memory capture promote")
    expect(captureLesson).toContain(
      "one short sentence naming only what was learned",
    )
    const userCodexToml = readFileSync(
      join(home, ".codex", "config.toml"),
      "utf8",
    )
    expect(userCodexToml).not.toContain("ctxpipe-memory")
    expect(userCodexToml).toContain("[other]")
    // Repo-scope init installs Codex hooks under the workspace, not only $HOME.
    const repoCodexToml = readFileSync(
      join(cwd, ".codex", "config.toml"),
      "utf8",
    )
    expect(repoCodexToml).toContain("memory capture finalize --host codex")
  })

  it("keeps a team README that names the memory-search skill and AgentMemory history", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-team-readme-"))
    const readme =
      "# Team memory\n\nWe moved off AgentMemory in August (see ADR-021).\nRecall with the memory-search skill.\n"
    mkdirSync(join(cwd, ".ai", "memory"), { recursive: true })
    writeFileSync(join(cwd, ".ai", "memory", "README.md"), readme)

    runMemoryInit(cwd, ["--agents", "cursor", "--non-interactive"])

    expect(readFileSync(join(cwd, ".ai", "memory", "README.md"), "utf8")).toBe(
      readme,
    )
  })

  it("memory doctor warns about uncommitted durable memory", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-doctor-"))
    execFileSync("git", ["init", "-q"], { cwd })
    mkdirSync(join(cwd, ".ai", "memory"), { recursive: true })
    writeFileSync(join(cwd, ".ai", "memory", "lessons-learned.md"), "### A\n")

    const out = JSON.parse(
      execFileSync(process.execPath, [BIN, "memory", "doctor", "--json"], {
        cwd,
        encoding: "utf8",
      }),
    ) as { checks: Array<{ name: string; status: string; detail: string }> }

    const check = out.checks.find((c) => c.name === "uncommitted")
    expect(check?.status).toBe("warn")
    expect(check?.detail).toContain(".ai/memory/lessons-learned.md")
  })

  it("memory status lists uncommitted memory files", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-status-"))
    execFileSync("git", ["init", "-q", "-b", "feature/memory"], { cwd })
    mkdirSync(join(cwd, ".ai", "memory"), { recursive: true })
    writeFileSync(join(cwd, ".ai", "memory", "lessons-learned.md"), "### A\n")

    const out = execFileSync(process.execPath, [BIN, "memory", "status"], {
      cwd,
      encoding: "utf8",
    })

    expect(out).toContain(".ai/memory/lessons-learned.md on feature/memory")
  })

  it("requires --agents in non-interactive mode", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-init-no-agents-"))
    expect(() => runMemoryInit(cwd, ["--non-interactive"])).toThrow(
      /Missing --agents/,
    )
  })
})

describe("generated memory hooks run the newest CLI", () => {
  const unpinned = "npx -y ctxpipe memory capture"

  it("writes the unpinned command in the hooks of each host", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-unpinned-"))
    runMemoryInit(
      cwd,
      ["--agents", "cursor,claude,codex,opencode,vscode", "--non-interactive"],
      mkdtempSync(join(tmpdir(), "ctxpipe-mem-unpinned-home-")),
    )

    for (const rel of [
      ".cursor/hooks.json",
      ".claude/settings.json",
      ".codex/config.toml",
      ".opencode/plugins/ctxpipe-memory.js",
      ".github/hooks/ctxpipe-memory.json",
      ".github/copilot-instructions.md",
      "AGENTS.md",
    ]) {
      const text = readFileSync(join(cwd, rel), "utf8")
      expect(text, rel).toContain(unpinned)
      expect(text, rel).not.toMatch(/ctxpipe@/)
    }
  })

  it("replaces a version-pinned capture hook with the unpinned one on re-init", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-unpin-reinit-"))
    mkdirSync(join(cwd, ".claude"), { recursive: true })
    mkdirSync(join(cwd, ".cursor"), { recursive: true })
    writeFileSync(
      join(cwd, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          Stop: [
            {
              hooks: [
                {
                  type: "command",
                  command:
                    "npx -y ctxpipe@0.5.2 memory capture finalize --host claude --event Stop",
                },
              ],
            },
          ],
        },
      }),
    )
    writeFileSync(
      join(cwd, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          stop: [
            {
              command:
                "npx -y ctxpipe@0.0.1 memory capture finalize --host cursor --event stop",
            },
          ],
        },
      }),
    )

    runMemoryInit(
      cwd,
      ["--agents", "claude,cursor", "--non-interactive"],
      mkdtempSync(join(tmpdir(), "ctxpipe-mem-unpin-home-")),
    )

    const claude = JSON.parse(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf8"),
    ) as { hooks: { Stop: Array<{ hooks: Array<{ command: string }> }> } }
    expect(
      claude.hooks.Stop.flatMap((g) => g.hooks.map((h) => h.command)),
    ).toEqual([`${unpinned} finalize --host claude --event Stop`])
    const cursor = JSON.parse(
      readFileSync(join(cwd, ".cursor", "hooks.json"), "utf8"),
    ) as { hooks: { stop: Array<{ command: string }> } }
    expect(cursor.hooks.stop.map((h) => h.command)).toEqual([
      `${unpinned} finalize --host cursor --event stop`,
    ])
  })
})

describe("the removed memory mcp and memory hook commands repair a 0.2.0 setup", () => {
  const legacyServer = {
    command: "npx",
    args: ["-y", "ctxpipe", "memory", "mcp"],
  }
  const remote = { url: "https://app.ctxpipe.ai/mcp/acme" }
  const userHook = { type: "command", command: "echo keep-me" }

  /** A repository and a home directory as `memory init` of CLI 0.2.0 left them, for each host. */
  function legacySetup(): { cwd: string; home: string } {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-repair-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-repair-home-"))
    const write = (path: string, content: unknown) => {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(
        path,
        typeof content === "string"
          ? content
          : `${JSON.stringify(content, null, 2)}\n`,
      )
    }
    write(join(cwd, ".ai", "memory", "README.md"), "# Project memory\n")
    write(join(cwd, ".cursor", "mcp.json"), {
      mcpServers: { ctxpipe: remote, "ctxpipe-memory": legacyServer },
    })
    write(join(cwd, ".mcp.json"), {
      mcpServers: { ctxpipe: remote, "ctxpipe-memory": legacyServer },
    })
    write(join(cwd, ".vscode", "mcp.json"), {
      servers: { "ctxpipe-memory": { type: "stdio", ...legacyServer } },
    })
    write(join(cwd, "opencode.json"), {
      mcp: {
        "ctxpipe-memory": {
          type: "local",
          command: ["npx", "-y", "ctxpipe", "memory", "mcp"],
        },
      },
    })
    write(join(home, ".claude", "settings.local.json"), {
      hooks: {
        SessionStart: [
          {
            hooks: [
              {
                type: "command",
                command: "npx -y ctxpipe memory hook claude-session-start",
              },
            ],
          },
        ],
        Stop: [
          {
            hooks: [
              userHook,
              {
                type: "command",
                command: "npx -y ctxpipe memory hook claude-stop",
                async: true,
              },
            ],
          },
        ],
      },
    })
    // The legacy table is last, so the capture-hook block comes right after it.
    write(
      join(cwd, ".codex", "config.toml"),
      `model = "gpt"\n\n[mcp_servers.ctxpipe-memory]\ncommand = "npx"\nargs = ["-y", "ctxpipe", "memory", "mcp"]\n`,
    )
    write(
      join(home, ".codex", "config.toml"),
      `model = "gpt"\n\n[mcp_servers.ctxpipe-memory]\ncommand = "npx"\nargs = ["-y", "ctxpipe", "memory", "mcp"]\n\n[mcp_servers.other]\ncommand = "other"\n`,
    )
    // `claude mcp add ctxpipe-memory --scope user` of CLI 0.2.0.
    write(join(home, ".claude.json"), {
      numStartups: 3,
      mcpServers: { ctxpipe: remote, "ctxpipe-memory": legacyServer },
    })
    return { cwd, home }
  }

  /**
   * A `claude` command on PATH that does what `claude mcp remove --scope user`
   * does to ~/.claude.json, and logs its arguments outside the home directory.
   */
  const fakeClaude = mkdtempSync(join(tmpdir(), "ctxpipe-mem-fake-claude-"))
  const claudeLog = join(fakeClaude, "calls.log")
  writeFileSync(
    join(fakeClaude, "claude"),
    `#!/usr/bin/env node
const fs = require("node:fs")
const path = require("node:path")
const args = process.argv.slice(2)
if (args[0] === "--version") process.exit(0)
fs.appendFileSync(${JSON.stringify(claudeLog)}, args.join(" ") + "\\n")
if (args[0] === "mcp" && args[1] === "remove") {
  const file = path.join(process.env.HOME, ".claude.json")
  const config = JSON.parse(fs.readFileSync(file, "utf8"))
  delete config.mcpServers[args[2]]
  fs.writeFileSync(file, JSON.stringify(config, null, 2))
}
`,
    { mode: 0o755 },
  )

  function runRemoved(
    cwd: string,
    home: string,
    command: "mcp" | "hook",
  ): ReturnType<typeof spawnSync> & { stdout: string; stderr: string } {
    const args = command === "hook" ? ["hook", "claude-session-start"] : ["mcp"]
    const input =
      command === "hook"
        ? JSON.stringify({ session_id: "s", cwd })
        : `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`
    return spawnSync(process.execPath, [BIN, "memory", ...args], {
      // A hook finds the repository from the `cwd` of its stdin JSON, so it
      // runs from another directory here. An MCP server uses its own directory.
      cwd: command === "hook" ? home : cwd,
      input,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PATH: `${fakeClaude}:${process.env.PATH ?? ""}`,
      },
    })
  }

  /** Every file under the roots, by path, so that a test can see any change. */
  function snapshot(...roots: string[]): Record<string, string> {
    const files: Record<string, string> = {}
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name)
        if (entry.isSymbolicLink()) files[path] = `-> ${readlinkSync(path)}`
        else if (entry.isDirectory()) walk(path)
        else files[path] = readFileSync(path, "utf8")
      }
    }
    for (const root of roots) walk(root)
    return files
  }

  it.each(["hook", "mcp"] as const)(
    "`memory %s` writes the repo capture hooks of each host, removes each 0.2.0 entry in the repository and the home directory, and a second run changes nothing",
    (command) => {
      const { cwd, home } = legacySetup()
      rmSync(claudeLog, { force: true })

      const first = runRemoved(cwd, home, command)

      expect(first.status).toBe(0)
      expect(first.stdout).toBe("")
      expect(first.stderr.trim().split("\n")).toEqual([
        `ctxpipe: \`memory ${command}\` was removed in 0.3.0. Removed the 0.2.0 memory entries and wrote the capture hooks of this repository for Cursor, Claude Code, VS Code / Copilot, OpenCode, Codex.`,
      ])
      for (const [path, text] of Object.entries(snapshot(cwd, home))) {
        expect(text, path).not.toMatch(
          /memory (mcp|hook)\b|ctxpipe-memory"?[:\]]/,
        )
      }
      const json = (path: string) =>
        JSON.parse(readFileSync(path, "utf8")) as {
          mcpServers?: unknown
          hooks?: unknown
          numStartups?: unknown
        }
      expect(json(join(cwd, ".cursor", "mcp.json")).mcpServers).toEqual({
        ctxpipe: remote,
      })
      expect(json(join(cwd, ".mcp.json")).mcpServers).toEqual({
        ctxpipe: remote,
      })
      expect(json(join(home, ".claude", "settings.local.json")).hooks).toEqual({
        SessionStart: [],
        Stop: [{ hooks: [userHook] }],
      })
      expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe(
        `model = "gpt"\n\n[mcp_servers.other]\ncommand = "other"\n`,
      )
      expect(readFileSync(claudeLog, "utf8")).toBe(
        "mcp remove ctxpipe-memory --scope user\n",
      )
      expect(json(join(home, ".claude.json"))).toEqual({
        numStartups: 3,
        mcpServers: { ctxpipe: remote },
      })
      // A home entry adds no user-scope capture hook.
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false)
      for (const [rel, capture] of [
        [".cursor/hooks.json", "memory capture finalize --host cursor"],
        [".claude/settings.json", "memory capture finalize --host claude"],
        [
          ".github/hooks/ctxpipe-memory.json",
          "memory capture finalize --host vscode",
        ],
        [".opencode/plugins/ctxpipe-memory.js", "memory capture"],
        [".codex/config.toml", "memory capture finalize --host codex"],
      ] as const) {
        expect(readFileSync(join(cwd, rel), "utf8"), rel).toContain(
          `npx -y ctxpipe ${capture}`,
        )
      }
      const codex = readFileSync(join(cwd, ".codex", "config.toml"), "utf8")
      expect(codex).toMatch(
        /^model = "gpt"\n\n# BEGIN ctxpipe-memory-capture\n/,
      )
      expect(codex).toContain("# END ctxpipe-memory-capture")
      expect(existsSync(join(cwd, ".ai", "memory", "index.md"))).toBe(true)

      const before = snapshot(cwd, home)
      const second = runRemoved(cwd, home, command === "hook" ? "mcp" : "hook")

      expect(second.status).toBe(0)
      expect(second.stdout).toBe("")
      expect(second.stderr.trim().split("\n")).toEqual([
        `ctxpipe: \`memory ${command === "hook" ? "mcp" : "hook"}\` was removed in 0.3.0. This repository has no 0.2.0 memory entry to repair.`,
      ])
      expect(snapshot(cwd, home)).toEqual(before)
      expect(readFileSync(claudeLog, "utf8")).toBe(
        "mcp remove ctxpipe-memory --scope user\n",
      )
    },
  )

  it("refuses the repair when a home file with a 0.2.0 entry is a symlink", () => {
    const { cwd, home } = legacySetup()
    const dotfiles = mkdtempSync(join(tmpdir(), "ctxpipe-mem-dotfiles-"))
    const settings = join(home, ".claude", "settings.local.json")
    writeFileSync(join(dotfiles, "settings.local.json"), readFileSync(settings))
    rmSync(settings)
    symlinkSync(join(dotfiles, "settings.local.json"), settings)
    const before = snapshot(cwd, home, dotfiles)

    const result = runRemoved(cwd, home, "mcp")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr.trim().split("\n")).toEqual([
      "ctxpipe: `memory mcp` was removed in 0.3.0. The repair of the memory setup failed (~/.claude/settings.local.json goes through a symlink). Run `npx ctxpipe memory init`.",
    ])
    expect(snapshot(cwd, home, dotfiles)).toEqual(before)
  })

  it("reports nothing to repair when no 0.2.0 entry is left", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-mem-repair-current-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-mem-repair-current-home-"))
    runMemoryInit(cwd, ["--agents", "claude", "--non-interactive"], home)
    const before = snapshot(cwd, home)

    const result = runRemoved(cwd, home, "mcp")

    expect(result.status).toBe(0)
    expect(result.stderr).toContain(
      "This repository has no 0.2.0 memory entry to repair.",
    )
    expect(snapshot(cwd, home)).toEqual(before)
  })

  it.each([
    [
      ".claude/rules",
      "outside",
      "a directory of hook files out of the repository",
    ],
    [
      ".ai/memory/patterns.md",
      "outside",
      "a migration input out of the repository",
    ],
    [
      ".ai/memory/lessons-learned.md",
      "inside",
      "a migration output to .git/config",
    ],
  ] as const)(
    "refuses the repair when %s is a symlink (%s: %s)",
    (rel, where, _why) => {
      const { cwd, home } = legacySetup()
      const outside = mkdtempSync(join(tmpdir(), "ctxpipe-mem-repair-outside-"))
      writeFileSync(join(outside, "secret"), "do not copy\n")
      mkdirSync(join(cwd, ".git"))
      writeFileSync(join(cwd, ".git", "config"), "[core]\n")
      writeFileSync(
        join(cwd, ".ai", "memory", "patterns.md"),
        "[core]\n\tfsmonitor = ./payload\n",
      )
      const path = join(cwd, rel)
      mkdirSync(dirname(path), { recursive: true })
      rmSync(path, { force: true })
      symlinkSync(
        where === "inside"
          ? join(cwd, ".git", "config")
          : rel.endsWith(".md")
            ? join(outside, "secret")
            : outside,
        path,
      )
      const before = snapshot(cwd, home, outside)

      const result = runRemoved(cwd, home, "mcp")

      expect(result.status).toBe(0)
      expect(result.stdout).toBe("")
      expect(result.stderr.trim().split("\n")).toEqual([
        `ctxpipe: \`memory mcp\` was removed in 0.3.0. The repair of the memory setup failed (${rel === ".claude/rules" ? ".claude/rules/ai-memory.md" : rel} goes through a symlink). Run \`npx ctxpipe memory init\`.`,
      ])
      expect(snapshot(cwd, home, outside)).toEqual(before)
    },
  )

  it("tries again after a partial failure when the only 0.2.0 entry is in the home directory", () => {
    const { cwd, home } = legacySetup()
    for (const rel of [
      ".cursor/mcp.json",
      ".mcp.json",
      ".vscode/mcp.json",
      "opencode.json",
      ".codex/config.toml",
    ]) {
      rmSync(join(cwd, rel))
    }
    rmSync(join(home, ".codex"), { recursive: true })
    rmSync(join(home, ".claude.json"))
    // A file where the Claude rule needs a directory: that write fails.
    mkdirSync(join(cwd, ".claude"))
    writeFileSync(join(cwd, ".claude", "rules"), "not a directory\n")

    const failed = runRemoved(cwd, home, "hook")

    expect(failed.stderr).toContain("The repair of the memory setup failed")
    expect(
      readFileSync(join(home, ".claude", "settings.local.json"), "utf8"),
    ).toContain("memory hook claude-stop")

    rmSync(join(cwd, ".claude", "rules"))
    const retried = runRemoved(cwd, home, "hook")

    expect(retried.stderr.trim()).toBe(
      "ctxpipe: `memory hook` was removed in 0.3.0. Removed the 0.2.0 memory entries and wrote the capture hooks of this repository for Claude Code.",
    )
    expect(
      readFileSync(join(cwd, ".claude", "settings.json"), "utf8"),
    ).toContain("npx -y ctxpipe memory capture finalize --host claude")
    expect(existsSync(join(cwd, ".claude", "rules", "ai-memory.md"))).toBe(true)
    expect(
      readFileSync(join(home, ".claude", "settings.local.json"), "utf8"),
    ).not.toContain("memory hook")
  })

  it("keeps the 0.2.0 entries for a retry when a migration step fails", () => {
    const { cwd, home } = legacySetup()
    // A directory where the migration writes lessons-learned.md: that write fails.
    mkdirSync(join(cwd, ".ai", "memory", "lessons-learned.md"))

    const failed = runRemoved(cwd, home, "mcp")

    expect(failed.stderr).toContain("The repair of the memory setup failed")
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain(
      "ctxpipe-memory",
    )
    expect(
      readFileSync(join(home, ".claude", "settings.local.json"), "utf8"),
    ).toContain("memory hook claude-stop")

    rmSync(join(cwd, ".ai", "memory", "lessons-learned.md"), {
      recursive: true,
    })
    const retried = runRemoved(cwd, home, "mcp")

    expect(retried.stderr).toContain("Removed the 0.2.0 memory entries")
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).not.toContain(
      "ctxpipe-memory",
    )
  })

  it("refuses the repair when a JSON file that it changes does not parse", () => {
    const { cwd, home } = legacySetup()
    writeFileSync(
      join(cwd, ".mcp.json"),
      '{\n  // a comment\n  "mcpServers": {}\n}\n',
    )
    const before = snapshot(cwd, home)

    const result = runRemoved(cwd, home, "mcp")

    expect(result.status).toBe(0)
    expect(result.stderr.trim().split("\n")).toEqual([
      "ctxpipe: `memory mcp` was removed in 0.3.0. The repair of the memory setup failed (.mcp.json is not a JSON object). Run `npx ctxpipe memory init`.",
    ])
    expect(snapshot(cwd, home)).toEqual(before)
  })

  it("changes nothing in a directory that has no .ai/memory", () => {
    const { cwd, home } = legacySetup()
    rmSync(join(cwd, ".ai"), { recursive: true })
    const before = snapshot(cwd, home)

    const result = runRemoved(cwd, home, "hook")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain(
      "This directory has no .ai/memory, so there is nothing to repair.",
    )
    expect(snapshot(cwd, home)).toEqual(before)
  })

  it("exits 0 with one stderr line when the repair cannot write a file", () => {
    const { cwd, home } = legacySetup()
    // A file where the hooks need the .claude directory: the write fails.
    writeFileSync(join(cwd, ".claude"), "not a directory\n")

    const result = runRemoved(cwd, home, "hook")

    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
    const lines = result.stderr.trim().split("\n")
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(
      /^ctxpipe: `memory hook` was removed in 0\.3\.0\. The repair of the memory setup failed \(.+\)\. Run `npx ctxpipe memory init`\.$/,
    )
    // The 0.2.0 entries stay, so the next run tries the repair again.
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toContain(
      "ctxpipe-memory",
    )
  })
})
