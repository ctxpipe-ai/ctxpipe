import { existsSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { CaptureHost } from "./capture.js"

/**
 * Cursor and VS Code also run Claude Code hooks from `.claude/settings.json`,
 * so a `--host claude` hook may be running inside either. Returns the host to
 * act as, or null when that tool has its own ctxpipe capture hook and this
 * copy must stand aside (otherwise both capture and race to deliver Stop).
 */
export function resolveCaptureHost(
  host: CaptureHost,
  payload: Record<string, unknown>,
  repoRoot: string,
  homeDir = homedir(),
): CaptureHost | null {
  if (host !== "claude") return host
  if (typeof payload.cursor_version === "string") {
    const own = [
      join(repoRoot, ".cursor", "hooks.json"),
      join(homeDir, ".cursor", "hooks.json"),
    ]
    return own.some(hasCaptureHook) ? null : host
  }
  // Claude Code sends no `timestamp`; VS Code's hook input always does.
  if (typeof payload.timestamp === "string") {
    const own = [
      join(repoRoot, ".github", "hooks", "ctxpipe-memory.json"),
      join(homeDir, ".copilot", "hooks", "ctxpipe-memory.json"),
    ]
    return own.some(hasCaptureHook) ? null : "vscode"
  }
  return host
}

function hasCaptureHook(path: string): boolean {
  try {
    return existsSync(path) && readFileSync(path, "utf8").includes("memory capture")
  } catch {
    return false
  }
}
