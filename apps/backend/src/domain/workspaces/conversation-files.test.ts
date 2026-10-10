import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  conversationPathIsSafe,
  conversationSandboxDiff,
  conversationSandboxStatus,
  conversationWorktreeVersion,
  fingerprintConversationWorktree,
  listConversationSandboxPaths,
  readConversationSandboxFile,
  sanitizeGitRemoteError,
  splitGitNulPaths,
} from "./conversation-files.js"
import { switchToSessionBranch } from "./conversation-session-branch.js"
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

  it("moves to the session branch with its files and never resets an existing one", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
      },
      async ({ directory, handle, git }) => {
        const session = "ctxpipe/chat/conv_1/1"
        const move = () =>
          switchToSessionBranch({
            handle,
            branch: session,
            defaultBranch: "main",
          })
        writeFileSync(join(directory, "draft.md"), "# Draft\n")
        expect(await move()).toBe(true)
        expect(git("branch", "--show-current")).toBe(session)
        expect(git("status", "--porcelain")).toBe("?? draft.md")
        git("add", "draft.md")
        git("commit", "-m", "Session work")
        const work = git("rev-parse", "HEAD")
        // The agent went back to the default branch; the session keeps its work.
        git("checkout", "main")
        expect(await move()).toBe(true)
        expect(git("branch", "--show-current")).toBe(session)
        expect(git("rev-parse", "HEAD")).toBe(work)
        // Another branch is left alone.
        git("checkout", "-b", "elsewhere")
        expect(await move()).toBe(true)
        expect(git("branch", "--show-current")).toBe("elsewhere")
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

  it("lists files the agent deleted, staged or not, as deleted", async () => {
    await withWorktree(
      (directory) => {
        mkdirSync(join(directory, "knowledge/archive"), { recursive: true })
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
        writeFileSync(join(directory, "knowledge/old.md"), "one\ntwo\n")
        writeFileSync(join(directory, "knowledge/archive/a.md"), "A\n")
      },
      async ({ directory, handle, git }) => {
        rmSync(join(directory, "knowledge/old.md"))
        git("rm", "-q", "-r", "knowledge/archive")
        const status = await conversationSandboxStatus({
          handle,
          defaultBranch: "main",
          sessionBranch: "main",
        })
        expect(status.items).toEqual([
          {
            path: "knowledge/archive/a.md",
            status: "deleted",
            additions: 0,
            deletions: 1,
          },
          {
            path: "knowledge/old.md",
            status: "deleted",
            additions: 0,
            deletions: 2,
          },
        ])
        expect(status.unpushed).toBe(true)
      },
    )
  })

  it("keeps a committed deletion listed until the base branch has it", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
        writeFileSync(join(directory, "knowledge.md"), "K\n")
        writeFileSync(join(directory, "restored.md"), "R\n")
      },
      async ({ directory, handle, git }) => {
        const remote = mkdtempSync(
          join(tmpdir(), "ctxpipe-conversation-remote-"),
        )
        try {
          execFileSync("git", ["init", "-q", "--bare", remote])
          git("remote", "add", "origin", remote)
          git("checkout", "-q", "-b", "ctxpipe/session")
          git("rm", "-q", "knowledge.md", "restored.md")
          git("commit", "-q", "-m", "Remove notes")
          writeFileSync(join(directory, "restored.md"), "R again\n")
          const status = () =>
            conversationSandboxStatus({
              handle,
              defaultBranch: "main",
              sessionBranch: "ctxpipe/session",
            })
          const deleted = async () =>
            (await status()).items
              .filter((item) => item.status === "deleted")
              .map((item) => item.path)

          expect(await deleted()).toEqual(["knowledge.md"])

          git("push", "-q", "origin", "ctxpipe/session")
          expect((await status()).published).toBe(true)
          expect(await deleted()).toEqual(["knowledge.md"])

          git("branch", "-f", "main", "ctxpipe/session")
          expect(await deleted()).toEqual([])
        } finally {
          rmSync(remote, { recursive: true, force: true })
        }
      },
    )
  })

  it("lists committed added and modified files against the base branch", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
        writeFileSync(join(directory, "notes.md"), "N\n")
        writeFileSync(join(directory, "scratch.md"), "S\n")
      },
      async ({ directory, handle, git }) => {
        git("checkout", "-q", "-b", "ctxpipe/session")
        mkdirSync(join(directory, "knowledge"), { recursive: true })
        writeFileSync(join(directory, "knowledge/new.md"), "fresh\n")
        writeFileSync(join(directory, "temp.md"), "gone soon\n")
        writeFileSync(join(directory, "notes.md"), "N\nmore\n")
        git("add", "-A")
        git("commit", "-q", "-m", "Add and change notes")
        writeFileSync(join(directory, "knowledge/new.md"), "fresh\nedit\n")
        rmSync(join(directory, "temp.md"))
        const status = () =>
          conversationSandboxStatus({
            handle,
            defaultBranch: "main",
            sessionBranch: "ctxpipe/session",
          })
        const changes = async () =>
          (await status()).items
            .map((item) => `${item.status} ${item.path}`)
            .sort()

        expect(await changes()).toEqual([
          "added knowledge/new.md",
          "modified notes.md",
        ])

        git("add", "-A")
        git("commit", "-q", "-m", "Drop temp")
        git("branch", "-f", "main", "ctxpipe/session")
        expect(await changes()).toEqual([])
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

  it("reads only the files the tree lists, never ignored files or .git", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, ".gitignore"), ".env\nsecret/\n")
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
      },
      async ({ directory, handle }) => {
        writeFileSync(join(directory, ".env"), "API_KEY=hidden\n")
        mkdirSync(join(directory, "secret"), { recursive: true })
        writeFileSync(join(directory, "secret/key.txt"), "hidden\n")
        writeFileSync(join(directory, "opencode.json"), "{}\n")
        writeFileSync(join(directory, "draft.md"), "fresh\n")
        const read = (path: string) => readConversationSandboxFile(handle, path)
        expect({
          gitConfig: await read(".git/config"),
          gitHead: await read(".git/HEAD"),
          env: await read(".env"),
          ignoredDirectory: await read("secret/key.txt"),
          harness: await read("opencode.json"),
          tracked: await read("AGENTS.md"),
          untracked: await read("draft.md"),
        }).toEqual({
          gitConfig: null,
          gitHead: null,
          env: null,
          ignoredDirectory: null,
          harness: null,
          tracked: { path: "AGENTS.md", body: "# Agents\n", binary: false },
          untracked: { path: "draft.md", body: "fresh\n", binary: false },
        })
      },
    )
  })

  it("does not read through a symlink, listed or not", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctxpipe-outside-"))
    writeFileSync(join(outside, "hosts"), "outside\n")
    try {
      await withWorktree(
        (directory) => {
          writeFileSync(join(directory, ".gitignore"), ".env\n")
          mkdirSync(join(directory, "docs"))
          writeFileSync(join(directory, "docs/hosts"), "tracked\n")
        },
        async ({ directory, handle }) => {
          writeFileSync(join(directory, ".env"), "API_KEY=hidden\n")
          symlinkSync(".env", join(directory, "env-link"))
          symlinkSync(join(outside, "hosts"), join(directory, "hosts-link"))
          // Git still lists docs/hosts from the index after this swap.
          rmSync(join(directory, "docs"), { recursive: true })
          symlinkSync(outside, join(directory, "docs"))
          const read = (path: string) =>
            readConversationSandboxFile(handle, path)
          expect({
            envLink: await read("env-link"),
            hostsLink: await read("hosts-link"),
            swappedParent: await read("docs/hosts"),
          }).toEqual({
            envLink: null,
            hostsLink: null,
            swappedParent: null,
          })
          expect({
            diff: (
              await conversationSandboxDiff({ handle, defaultBranch: "main" })
            ).map(({ path, body }) => ({ path, body })),
          }).toEqual({
            diff: expect.arrayContaining([
              { path: "env-link", body: null },
              { path: "hosts-link", body: null },
            ]),
          })
        },
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("does not read a diff path that git now ignores and does not track", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, ".env"), "API_KEY=committed\n")
      },
      async ({ directory, handle, git }) => {
        git("checkout", "-q", "-b", "ctxpipe/session")
        git("rm", "-q", "--cached", ".env")
        writeFileSync(join(directory, ".gitignore"), ".env\n")
        git("add", ".gitignore")
        git("commit", "-q", "-m", "Ignore .env")
        writeFileSync(join(directory, ".env"), "API_KEY=secret\n")

        const diff = await conversationSandboxDiff({
          handle,
          defaultBranch: "main",
        })

        expect(diff.find((file) => file.path === ".env")).toEqual({
          path: ".env",
          oldBody: "API_KEY=committed\n",
          body: null,
        })
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

describe("conversation sandbox paths", () => {
  it("splits NUL-delimited git paths including names with spaces", () => {
    expect(splitGitNulPaths("knowledge/a file.md\0linear/issue.md\0")).toEqual([
      "knowledge/a file.md",
      "linear/issue.md",
    ])
    expect(splitGitNulPaths("")).toEqual([])
  })

  it("refuses path traversal", () => {
    expect(conversationPathIsSafe("knowledge/a.md")).toBe(true)
    expect(conversationPathIsSafe("knowledge/a file.md")).toBe(true)
    expect(conversationPathIsSafe("../secret")).toBe(false)
    expect(conversationPathIsSafe("/etc/passwd")).toBe(false)
    expect(conversationPathIsSafe("foo/../bar")).toBe(false)
  })
})
