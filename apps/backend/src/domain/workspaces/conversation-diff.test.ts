import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  changedFileDiffs,
  conversationBaseDiff,
  conversationTurnFiles,
  DIFF_BODY_LIMIT_BYTES,
  pruneConversationTurnSnapshots,
  snapshotConversationTurn,
  turnSnapshotKey,
  turnSnapshotsExist,
} from "./conversation-diff.js"
import type { JobSandboxHandle } from "./job-worktree.js"

function realHandle(directory: string): JobSandboxHandle {
  return {
    exec: async (command, options) => {
      try {
        const stdout = execFileSync("bash", ["-c", command], {
          cwd: directory,
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
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
    directory: string
    handle: JobSandboxHandle
    write: (path: string, body: string | Buffer) => void
    git: (...args: string[]) => string
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-conversation-diff-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  const write = (path: string, body: string | Buffer) => {
    mkdirSync(join(directory, path, ".."), { recursive: true })
    writeFileSync(join(directory, path), body)
  }
  try {
    git("init", "-q", "-b", "main")
    git("config", "user.name", "Fixture")
    git("config", "user.email", "fixture@example.test")
    write("keep.md", "one\ntwo\n")
    write("drop.md", "a\nb\nc\n")
    write("move-me.md", "line 1\nline 2\nline 3\nline 4\nline 5\n")
    write(".gitignore", ".env\n")
    git("add", ".")
    git("commit", "-q", "-m", "Initial")
    await run({ directory, handle: realHandle(directory), write, git })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const key = (runId: string) => turnSnapshotKey(runId, 1_700_000_000_000)

describe("conversation diffs", { timeout: 20_000 }, () => {
  it("gives the status, counts and bodies of each file from one diff, with renames", async () => {
    await withRepo(async ({ directory, handle, write, git }) => {
      write("earlier.md", "before the turn\n")
      const start = await snapshotConversationTurn(
        handle,
        key("run_1"),
        "start",
      )
      write("keep.md", "one\n2\nthree\n")
      write("docs/new.md", "x\ny\n")
      write(".env", "SECRET=1\n")
      write("opencode.json", "{}\n")
      write("image.bin", Buffer.from([0, 1, 2, 0, 255]))
      write("big.md", `${"x".repeat(DIFF_BODY_LIMIT_BYTES)}\n`)
      rmSync(join(directory, "drop.md"))
      git("mv", "move-me.md", "moved.md")
      symlinkSync(".env", join(directory, "env-link"))
      const end = await snapshotConversationTurn(handle, key("run_1"), "end")

      const files = await conversationTurnFiles(handle, start, end)
      expect(
        files.map(
          ({ path, status, additions, deletions, omitted, oldPath }) => ({
            path,
            status,
            additions,
            deletions,
            omitted,
            oldPath,
          }),
        ),
      ).toEqual([
        {
          path: "big.md",
          status: "added",
          additions: 1,
          deletions: 0,
          omitted: undefined,
          oldPath: undefined,
        },
        {
          path: "docs/new.md",
          status: "added",
          additions: 2,
          deletions: 0,
          omitted: undefined,
          oldPath: undefined,
        },
        {
          path: "drop.md",
          status: "deleted",
          additions: 0,
          deletions: 3,
          omitted: undefined,
          oldPath: undefined,
        },
        {
          path: "env-link",
          status: "added",
          additions: 1,
          deletions: 0,
          omitted: "not_a_file",
          oldPath: undefined,
        },
        {
          path: "image.bin",
          status: "added",
          additions: 0,
          deletions: 0,
          omitted: "binary",
          oldPath: undefined,
        },
        {
          path: "keep.md",
          status: "modified",
          additions: 2,
          deletions: 1,
          omitted: undefined,
          oldPath: undefined,
        },
        {
          path: "moved.md",
          status: "renamed",
          additions: 0,
          deletions: 0,
          omitted: undefined,
          oldPath: "move-me.md",
        },
      ])

      const diffs = await changedFileDiffs(handle, start.tree, end.tree)
      const byPath = new Map(diffs.map((diff) => [diff.path, diff]))
      expect(byPath.get("keep.md")).toMatchObject({
        oldBody: "one\ntwo\n",
        body: "one\n2\nthree\n",
      })
      expect(byPath.get("docs/new.md")).toMatchObject({
        oldBody: null,
        body: "x\ny\n",
      })
      expect(byPath.get("drop.md")).toMatchObject({
        oldBody: "a\nb\nc\n",
        body: null,
      })
      expect(byPath.get("moved.md")).toMatchObject({
        oldBody: "line 1\nline 2\nline 3\nline 4\nline 5\n",
      })
      expect(byPath.get("big.md")).toMatchObject({
        omitted: "too_large",
        body: null,
      })
      expect(byPath.get("image.bin")).toMatchObject({
        omitted: "binary",
        body: null,
      })
      // A symlink is not read: its target is never shown as a body.
      expect(byPath.get("env-link")).toMatchObject({
        omitted: "not_a_file",
        body: null,
      })

      // The snapshots do not touch the real index or the work tree.
      expect(git("status", "--porcelain")).toContain("?? earlier.md")
      // Only the user's own `git mv` is staged; the snapshot added nothing.
      expect(git("diff", "--cached", "--no-renames", "--name-only")).toBe(
        "move-me.md\nmoved.md",
      )
    })
  })

  it("finds no change when the turn only reads files", async () => {
    await withRepo(async ({ handle }) => {
      const start = await snapshotConversationTurn(
        handle,
        key("run_2"),
        "start",
      )
      const end = await snapshotConversationTurn(handle, key("run_2"), "end")
      expect(end.tree).toBe(start.tree)
      expect(await conversationTurnFiles(handle, start, end)).toEqual([])
    })
  })

  it("leaves out files that only follow an upstream change during the turn", async () => {
    await withRepo(async ({ handle, write, git }) => {
      git("update-ref", "refs/remotes/ctxpipe/base", "HEAD")
      const start = await snapshotConversationTurn(
        handle,
        key("run_3"),
        "start",
      )
      // Upstream changes keep.md; the turn rebases onto it and edits drop.md.
      git("checkout", "-q", "-b", "upstream")
      write("keep.md", "upstream\n")
      git("commit", "-q", "-am", "Upstream")
      git("update-ref", "refs/remotes/ctxpipe/base", "HEAD")
      write("drop.md", "a\nb\nc\nturn\n")
      const end = await snapshotConversationTurn(handle, key("run_3"), "end")
      expect(end.base).not.toBe(start.base)
      expect(
        (await conversationTurnFiles(handle, start, end)).map(
          (file) => file.path,
        ),
      ).toEqual(["drop.md"])
    })
  })

  it("keeps the snapshot refs of the newest turns only, and sees when a snapshot is gone", async () => {
    await withRepo(async ({ handle, write, git }) => {
      const snapshots = []
      for (let turn = 1; turn <= 3; turn += 1) {
        write("keep.md", `turn ${turn}\n`)
        snapshots.push(
          await snapshotConversationTurn(
            handle,
            turnSnapshotKey(`run_${turn}`, turn),
            "end",
          ),
        )
      }
      await pruneConversationTurnSnapshots(handle, 2)
      const refs = git(
        "for-each-ref",
        "--format=%(refname)",
        "refs/ctxpipe/turns/",
      )
      expect(refs.split("\n")).toEqual([
        `refs/ctxpipe/turns/${turnSnapshotKey("run_2", 2)}/end`,
        `refs/ctxpipe/turns/${turnSnapshotKey("run_3", 3)}/end`,
      ])
      const first = snapshots[0]?.tree ?? ""
      const last = snapshots[2]?.tree ?? ""
      expect(await turnSnapshotsExist(handle, first, last)).toBe(true)
      expect(await turnSnapshotsExist(handle, "0".repeat(40), last)).toBe(false)
      await pruneConversationTurnSnapshots(handle, 0)
      expect(git("for-each-ref", "refs/ctxpipe/turns/")).toBe("")
    })
  })

  it("compares the work tree with the merge base of the conversation base", async () => {
    await withRepo(async ({ handle, write, git }) => {
      git("checkout", "-q", "-b", "ctxpipe/session")
      write("keep.md", "session\n")
      git("commit", "-q", "-am", "Session")
      write("draft.md", "draft\n")
      // The default branch moves on; the diff still uses the merge base.
      git("checkout", "-q", "main")
      write("drop.md", "main moved\n")
      git("commit", "-q", "-am", "Main moves")
      git("checkout", "-q", "ctxpipe/session")
      const diff = await conversationBaseDiff({ handle, defaultBranch: "main" })
      expect(
        diff.map(({ path, status, oldBody, body }) => ({
          path,
          status,
          oldBody,
          body,
        })),
      ).toEqual([
        { path: "draft.md", status: "added", oldBody: null, body: "draft\n" },
        {
          path: "keep.md",
          status: "modified",
          oldBody: "one\ntwo\n",
          body: "session\n",
        },
      ])
    })
  })
})
