import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  conversationTurnDiff,
  conversationTurnFiles,
  snapshotConversationTurn,
} from "./conversation-turn-changes.js"
import type { JobSandboxHandle } from "./job-worktree.js"

function realHandle(directory: string): JobSandboxHandle {
  return {
    exec: async (command, options) => {
      try {
        const stdout = execFileSync("bash", ["-c", command], {
          cwd: directory,
          encoding: "utf8",
          env: options?.env ? { ...process.env, ...options.env } : process.env,
        })
        return { stdout, stderr: "", exitCode: 0 }
      } catch (error) {
        const failed = error as {
          stdout?: string
          stderr?: string
          status?: number
        }
        return {
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? String(error),
          exitCode: failed.status ?? 1,
        }
      }
    },
    fs: {
      write: async () => {},
      read: async () => "",
      remove: async () => {},
      mkdir: async () => {},
    },
  }
}

async function withRepo(
  run: (input: {
    handle: JobSandboxHandle
    write: (path: string, body: string) => void
    git: (...args: string[]) => string
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-turn-changes-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  const write = (path: string, body: string) => {
    mkdirSync(join(directory, path, ".."), { recursive: true })
    writeFileSync(join(directory, path), body)
  }
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.test")
    write("keep.md", "one\ntwo\n")
    write("drop.md", "a\nb\nc\n")
    write(".gitignore", ".env\n")
    git("add", ".")
    git("commit", "-q", "-m", "Initial")
    await run({ handle: realHandle(directory), write, git })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe("conversation turn changes", { timeout: 15_000 }, () => {
  it("lists only the files that changed during the turn, with line counts", async () => {
    await withRepo(async ({ handle, write, git }) => {
      // Work from an earlier turn, not committed, is not this turn's change.
      write("earlier.md", "before the turn\n")
      const start = await snapshotConversationTurn(handle, "run_1", "start")
      write("keep.md", "one\n2\nthree\n")
      write("docs/new.md", "x\ny\n")
      write(".env", "SECRET=1\n")
      write("opencode.json", "{}\n")
      rmSync(join(git("rev-parse", "--show-toplevel"), "drop.md"))
      const end = await snapshotConversationTurn(handle, "run_1", "end")

      expect(await conversationTurnFiles(handle, start, end)).toEqual([
        { path: "docs/new.md", status: "added", additions: 2, deletions: 0 },
        { path: "drop.md", status: "deleted", additions: 0, deletions: 3 },
        { path: "keep.md", status: "modified", additions: 2, deletions: 1 },
      ])
      // The snapshots do not touch the real index or the work tree.
      expect(git("status", "--porcelain")).toContain("?? earlier.md")
      expect(git("diff", "--cached", "--name-only")).toBe("")
      // A ref keeps each snapshot from garbage collection.
      expect(git("rev-parse", "refs/ctxpipe/turns/run_1/end")).toBe(end)

      expect(
        await conversationTurnDiff(handle, start, end, [
          "keep.md",
          "docs/new.md",
          "drop.md",
        ]),
      ).toEqual([
        { path: "keep.md", oldBody: "one\ntwo\n", body: "one\n2\nthree\n" },
        { path: "docs/new.md", oldBody: null, body: "x\ny\n" },
        { path: "drop.md", oldBody: "a\nb\nc\n", body: null },
      ])
    })
  })

  it("finds no change when the turn only reads files", async () => {
    await withRepo(async ({ handle }) => {
      const start = await snapshotConversationTurn(handle, "run_2", "start")
      const end = await snapshotConversationTurn(handle, "run_2", "end")
      expect(end).toBe(start)
      expect(await conversationTurnFiles(handle, start, end)).toEqual([])
    })
  })
})
