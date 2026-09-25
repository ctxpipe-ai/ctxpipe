import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { resolveCaptureHost } from "../../src/memory/harness.js"

function dirs(prefix: string): { repo: string; home: string } {
  return {
    repo: mkdtempSync(join(tmpdir(), `${prefix}-repo-`)),
    home: mkdtempSync(join(tmpdir(), `${prefix}-home-`)),
  }
}

function writeCaptureHook(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, '{"command":"npx -y ctxpipe memory capture finalize"}')
}

describe("memory/harness", () => {
  it("keeps the host for Claude Code and every native hook", () => {
    const { repo, home } = dirs("harness-native")
    const claudePayload = { session_id: "s", permission_mode: "default" }
    expect(resolveCaptureHost("claude", claudePayload, repo, home)).toBe(
      "claude",
    )
    expect(
      resolveCaptureHost("cursor", { cursor_version: "3.14" }, repo, home),
    ).toBe("cursor")
    expect(
      resolveCaptureHost("vscode", { timestamp: "2026-09-24" }, repo, home),
    ).toBe("vscode")
  })

  it("stands a Claude-format hook aside in Cursor when Cursor has its own capture hook", () => {
    const { repo, home } = dirs("harness-cursor")
    const payload = { cursor_version: "3.14", status: "completed" }
    expect(resolveCaptureHost("claude", payload, repo, home)).toBe("claude")

    writeCaptureHook(join(repo, ".cursor", "hooks.json"))
    expect(resolveCaptureHost("claude", payload, repo, home)).toBeNull()
  })

  it("runs a Claude-format hook as VS Code in VS Code, unless VS Code has its own capture hook", () => {
    const { repo, home } = dirs("harness-vscode")
    const payload = { timestamp: "2026-09-24T03:00:00Z", stop_hook_active: false }
    expect(resolveCaptureHost("claude", payload, repo, home)).toBe("vscode")

    writeCaptureHook(join(home, ".copilot", "hooks", "ctxpipe-memory.json"))
    expect(resolveCaptureHost("claude", payload, repo, home)).toBeNull()
  })
})
