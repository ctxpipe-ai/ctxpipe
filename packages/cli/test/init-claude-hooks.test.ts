import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
const BIN = join(PKG_ROOT, "bin", "ctxpipe.js")

function runInit(cwd: string, home: string, args: string[]): string {
  return execFileSync(process.execPath, [BIN, "init", ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
    },
  })
}

describe("init --claude-hooks", () => {
  it("writes Claude SessionStart/Stop hooks under ~/.claude/settings.local.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-claude-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-claude-home-"))
    runInit(cwd, home, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "claude",
      "--memory",
      "--claude-hooks",
      "--non-interactive",
    ])
    const settingsPath = join(home, ".claude", "settings.local.json")
    expect(existsSync(settingsPath)).toBe(true)
    const settings = JSON.parse(readFileSync(settingsPath, "utf8")) as {
      hooks?: Record<
        string,
        Array<{ hooks: Array<{ type: string; command: string; async?: boolean }> }>
      >
    }
    const sessionStart = settings.hooks?.SessionStart?.[0]?.hooks?.[0]
    const stop = settings.hooks?.Stop?.[0]?.hooks?.[0]
    expect(sessionStart?.type).toBe("command")
    expect(sessionStart?.command).toMatch(
      /npx -y ctxpipe memory hook claude-session-start/,
    )
    expect(stop?.command).toMatch(/npx -y ctxpipe memory hook claude-stop/)
    expect(stop?.async).toBe(true)
  })

  it("preserves unrelated entries in an existing settings.local.json", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-claude-merge-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-claude-merge-home-"))
    const claudeDir = join(home, ".claude")
    const fs = require("node:fs") as typeof import("node:fs")
    fs.mkdirSync(claudeDir, { recursive: true })
    writeFileSync(
      join(claudeDir, "settings.local.json"),
      JSON.stringify({ theme: "dark", hooks: { SessionStart: [] } }),
      "utf8",
    )
    runInit(cwd, home, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "claude",
      "--memory",
      "--claude-hooks",
      "--non-interactive",
    ])
    const settings = JSON.parse(
      readFileSync(join(claudeDir, "settings.local.json"), "utf8"),
    ) as { theme?: string; hooks?: Record<string, unknown> }
    expect(settings.theme).toBe("dark")
    expect(settings.hooks?.SessionStart).toBeDefined()
    expect(settings.hooks?.Stop).toBeDefined()
  })

  it("does not touch ~/.claude when --claude-hooks is omitted", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ctxpipe-claude-skip-"))
    const home = mkdtempSync(join(tmpdir(), "ctxpipe-claude-skip-home-"))
    runInit(cwd, home, [
      "--org",
      "acme",
      "--scope",
      "repo",
      "--agents",
      "claude",
      "--memory",
      "--non-interactive",
    ])
    expect(existsSync(join(home, ".claude", "settings.local.json"))).toBe(false)
  })
})
