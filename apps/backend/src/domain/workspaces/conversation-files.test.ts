import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import type { JobSandboxHandle } from "./job-worktree.js"
import {
  conversationWorktreeVersion,
  ensureConversationSessionBranch,
  fingerprintConversationWorktree,
  listConversationSandboxPaths,
  sanitizeGitRemoteError,
} from "./conversation-files.js"

function realHandle(directory: string): JobSandboxHandle {
  return {
    exec: async (command, options) => {
      try {
        const stdout = execFileSync("bash", ["-c", command], {
          cwd: directory,
          encoding: "utf8",
          env: options?.env
            ? { ...process.env, ...options.env }
            : process.env,
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
      write: async (path, data) => {
        writeFileSync(join(directory, path), data)
      },
      read: async (path) => readFileSync(join(directory, path), "utf8"),
      remove: async (path) => {
        rmSync(join(directory, path), { force: true })
      },
      mkdir: async (path) => {
        mkdirSync(join(directory, path), { recursive: true })
      },
    },
  }
}

function withWorktree<T>(
  seed: (directory: string) => void,
  run: (input: {
    directory: string
    handle: JobSandboxHandle
    git: (...args: string[]) => string
  }) => Promise<T>,
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), "ctxpipe-conversation-files-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim()
  git("init", "-b", "main")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  seed(directory)
  git("add", ".")
  git("commit", "-m", "Initial")
  return run({ directory, handle: realHandle(directory), git }).finally(() =>
    rmSync(directory, { recursive: true, force: true }),
  )
}

describe("conversation sandbox files", { timeout: 15_000 }, () => {
  it("strips tokens from git remote errors", () => {
    expect(
      sanitizeGitRemoteError("fatal: token ghp_secret denied", "ghp_secret"),
    ).toBe("fatal: token *** denied")
  })

  it("fingerprints HEAD, the tracked diff, and untracked file digests", () => {
    const first = fingerprintConversationWorktree({
      headSha: "abc123\n",
      trackedDiff: "diff --git a/notes.md\n+hello\n",
      untracked: [{ path: "new.md", digest: "deadbeef" }],
    })
    const second = fingerprintConversationWorktree({
      headSha: "abc123",
      trackedDiff: "diff --git a/notes.md\n+hello\n",
      untracked: [{ path: "new.md", digest: "deadbeef" }],
    })
    const afterEdit = fingerprintConversationWorktree({
      headSha: "abc123",
      trackedDiff: "diff --git a/notes.md\n+hello world\n",
      untracked: [{ path: "new.md", digest: "deadbeef" }],
    })
    expect(first).toBe(second)
    expect(first).toBe(
      createHash("sha256")
        .update("abc123\n")
        .update("diff --git a/notes.md\n+hello\n")
        .update("\n")
        .update("new.md")
        .update("\0")
        .update("deadbeef")
        .update("\n")
        .digest("hex"),
    )
    expect(afterEdit).not.toBe(first)
  })

  it("checks out the session branch and skips when HEAD already matches", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
      },
      async ({ handle, git }) => {
        const branch = await ensureConversationSessionBranch({
          conversationId: "conv_1",
          defaultBranch: "main",
          handle,
        })
        expect(branch).toBe("ctxpipe/chat/conv_1/1")
        expect(git("branch", "--show-current")).toBe("ctxpipe/chat/conv_1/1")
        const again = await ensureConversationSessionBranch({
          conversationId: "conv_1",
          defaultBranch: "main",
          handle,
        })
        expect(again).toBe("ctxpipe/chat/conv_1/1")
        expect(git("branch", "--show-current")).toBe("ctxpipe/chat/conv_1/1")
      },
    )
  })

  it("does not wipe sandbox PATH with an empty exec env", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
      },
      async ({ handle }) => {
        const envs: Array<Record<string, string> | undefined> = []
        const wrapped: JobSandboxHandle = {
          ...handle,
          exec: async (command, options) => {
            envs.push(options?.env)
            return handle.exec(command, options)
          },
        }
        expect(await listConversationSandboxPaths(wrapped)).toEqual([
          "AGENTS.md",
        ])
        expect(envs.length).toBeGreaterThan(0)
        expect(envs.every((env) => env === undefined)).toBe(true)
      },
    )
  })

  it("lists tracked and untracked paths and omits harness files", async () => {
    await withWorktree(
      (directory) => {
        mkdirSync(join(directory, "knowledge"), { recursive: true })
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
        writeFileSync(join(directory, "knowledge/a.md"), "A\n")
        writeFileSync(join(directory, "opencode.json"), "{}\n")
      },
      async ({ directory, handle }) => {
        writeFileSync(join(directory, "new.md"), "fresh\n")
        writeFileSync(join(directory, ".tanstack-projected-bar"), "x\n")
        mkdirSync(join(directory, "tmp/tanstack-ai-sandboxes"), {
          recursive: true,
        })
        writeFileSync(join(directory, "tmp/tanstack-ai-sandboxes/x"), "x\n")
        expect(await listConversationSandboxPaths(handle)).toEqual([
          "AGENTS.md",
          "knowledge/a.md",
          "new.md",
        ])
      },
    )
  })

  it("reads a worktree version from native git without staging", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "notes.md"), "hello\n")
      },
      async ({ directory, handle, git }) => {
        const clean = await conversationWorktreeVersion(handle)
        expect(clean).toMatch(/^[0-9a-f]{64}$/)
        writeFileSync(join(directory, "notes.md"), "hello world\n")
        writeFileSync(join(directory, "new.md"), "fresh")
        const dirty = await conversationWorktreeVersion(handle)
        expect(dirty).toMatch(/^[0-9a-f]{64}$/)
        expect(dirty).not.toBe(clean)
        expect(dirty).not.toBe(
          fingerprintConversationWorktree({
            headSha: git("rev-parse", "HEAD"),
            trackedDiff: "",
            untracked: [],
          }),
        )
        expect(await conversationWorktreeVersion(handle)).toBe(dirty)
        expect(git("diff", "--cached", "--name-only")).toBe("")
      },
    )
  })

  it("does not treat an unreadable untracked file as empty content", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
      },
      async ({ directory, handle }) => {
        writeFileSync(join(directory, "new.md"), "fresh")
        handle.fs.read = async () => {
          throw new Error("ENOENT")
        }
        await expect(conversationWorktreeVersion(handle)).rejects.toThrow(
          /untracked worktree file/,
        )
      },
    )
  })
})
