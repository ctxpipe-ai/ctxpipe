import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { DockerHandle } from "@tanstack/ai-sandbox-docker"
import { describe, expect, it } from "vitest"

import { conversationBaseDiff } from "./conversation-diff.js"
import {
  ConversationFileChangedError,
  conversationPathIsSafe,
  conversationRevisionStatus,
  conversationSandboxStatus,
  conversationWorktreeVersion,
  fingerprintConversationWorktree,
  listConversationSandboxPaths,
  readConversationSandboxFile,
  readConversationSandboxFileBytes,
  removeConversationSandboxPath,
  renameConversationSandboxPath,
  sanitizeGitRemoteError,
  splitGitNulPaths,
  writeConversationSandboxFile,
} from "./conversation-files.js"
import { switchToSessionBranch } from "./conversation-session-branch.js"
import { adaptTanstackHandle } from "./job-sandbox.js"
import type { JobSandboxHandle } from "./job-worktree.js"
import type { WorkspaceRevision } from "./revision.js"
import { advanceConversationWorktree } from "./workspace-chat-revision-transition.js"

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
  it("gives no notice for a conversation without changes after the Workspace moved", () => {
    expect(
      conversationRevisionStatus({
        sha: "aaa",
        desiredSha: "bbb",
        differsFromDefault: false,
        unpushed: false,
      }),
    ).toEqual({
      sha: "aaa",
      desiredSha: "bbb",
      stale: true,
      workspaceMovedUnderChanges: false,
    })
  })

  it("reports a Workspace move under the conversation's own changes", () => {
    const moved = (change: {
      differsFromDefault: boolean
      unpushed: boolean
    }) =>
      conversationRevisionStatus({ sha: "aaa", desiredSha: "bbb", ...change })
        .workspaceMovedUnderChanges
    expect(moved({ differsFromDefault: true, unpushed: false })).toBe(true)
    expect(moved({ differsFromDefault: false, unpushed: true })).toBe(true)
    expect(
      conversationRevisionStatus({
        sha: "bbb",
        desiredSha: "bbb",
        differsFromDefault: true,
        unpushed: true,
      }),
    ).toMatchObject({ stale: false, workspaceMovedUnderChanges: false })
  })

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
        writeFileSync(join(directory, "draft.md"), "new, not committed\n")
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
          "added draft.md",
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

  it("saves root, existing, and dash-named files in a Docker sandbox", async () => {
    const directory = mkdtempSync(join(tmpdir(), "ctxpipe-docker-write-"))
    try {
      writeFileSync(join(directory, "notes.md"), "old\n")
      // The Docker handle's own file writes, with the container's shell
      // replaced by a local shell in the same working directory.
      const docker = new DockerHandle({
        container: { id: "fixture" },
        workdir: "/workspace",
      } as unknown as ConstructorParameters<typeof DockerHandle>[0])
      const shell = realHandle(directory)
      Object.assign(docker, {
        exec: (command: string) => shell.exec(command),
      })
      const handle = adaptTanstackHandle(
        docker as unknown as Parameters<typeof adaptTanstackHandle>[0],
      )
      await writeConversationSandboxFile({
        handle,
        path: "referral-faq.md",
        body: "# FAQ\n",
      })
      await writeConversationSandboxFile({
        handle,
        path: "notes.md",
        body: "new\n",
      })
      expect(readFileSync(join(directory, "referral-faq.md"), "utf8")).toBe(
        "# FAQ\n",
      )
      expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("new\n")
      // A leading dash is not an option to mkdir.
      await writeConversationSandboxFile({
        handle,
        path: "-docs/a.md",
        body: "dash\n",
      })
      expect(readFileSync(join(directory, "-docs/a.md"), "utf8")).toBe("dash\n")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("lists only the conversation's own changes after the Workspace moves on", async () => {
    const root = mkdtempSync(join(tmpdir(), "ctxpipe-conversation-advance-"))
    const upstream = join(root, "upstream")
    const sandbox = join(root, "sandbox")
    const git = (cwd: string, ...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.name=Fixture", "-c", "user.email=f@example.test", ...args],
        { cwd, encoding: "utf8" },
      ).trim()
    try {
      mkdirSync(upstream)
      git(upstream, "init", "-q", "-b", "main")
      writeFileSync(join(upstream, "AGENTS.md"), "# Agents\n")
      git(upstream, "add", ".")
      git(upstream, "commit", "-q", "-m", "Initial")
      const oldSha = git(upstream, "rev-parse", "HEAD")
      git(root, "clone", "-q", upstream, sandbox)
      git(sandbox, "checkout", "-q", "-b", "ctxpipe/session")
      writeFileSync(join(sandbox, "agent.md"), "the agent's file\n")
      // ctxpipe pushes to the default branch after the conversation starts.
      writeFileSync(join(upstream, "AGENTS.md"), "# Agents\nmore\n")
      writeFileSync(join(upstream, "imported.md"), "imported\n")
      git(upstream, "add", ".")
      git(upstream, "commit", "-q", "-m", "Knowledge update")
      const newSha = git(upstream, "rev-parse", "HEAD")
      const job = realHandle(sandbox)
      const revision = {
        workspaceId: "ws_fixture",
        generation: 1,
        remote: { url: upstream, connectionId: null },
        defaultBranch: "main",
        sha: oldSha,
        access: "publish-session",
      } satisfies WorkspaceRevision
      expect(
        await advanceConversationWorktree({
          handle: { process: { exec: job.exec } } as unknown as Parameters<
            typeof advanceConversationWorktree
          >[0]["handle"],
          from: revision,
          to: { ...revision, sha: newSha },
        }),
      ).toBe("moved")
      expect(git(sandbox, "rev-parse", "HEAD")).toBe(newSha)

      const status = await conversationSandboxStatus({
        handle: job,
        defaultBranch: "main",
        sessionBranch: "ctxpipe/session",
      })
      expect(status.items.map((item) => `${item.status} ${item.path}`)).toEqual(
        ["added agent.md"],
      )
      expect(status.ahead).toBe(0)
      expect(
        (
          await conversationBaseDiff({ handle: job, defaultBranch: "main" })
        ).map((diff) => diff.path),
      ).toEqual(["agent.md"])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("reconciles uncommitted work with the base branch", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "AGENTS.md"), "# Agents\n")
        writeFileSync(join(directory, "notes.md"), "N\n")
        writeFileSync(join(directory, "pricing.md"), "P\n")
      },
      async ({ directory, handle, git }) => {
        git("checkout", "-q", "-b", "ctxpipe/session")
        writeFileSync(join(directory, "notes.md"), "N\nmore\n")
        git("rm", "-q", "pricing.md")
        git("commit", "-q", "-am", "Change notes, drop pricing")
        writeFileSync(join(directory, "notes.md"), "N\n")
        writeFileSync(join(directory, "pricing.md"), "P again\n")
        mkdirSync(join(directory, "guides/setup"), { recursive: true })
        writeFileSync(join(directory, "guides/setup/install.md"), "I\n")
        const status = await conversationSandboxStatus({
          handle,
          defaultBranch: "main",
          sessionBranch: "ctxpipe/session",
        })
        expect(
          status.items.map((item) => `${item.status} ${item.path}`).sort(),
        ).toEqual(["added guides/setup/install.md", "modified pricing.md"])
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

  it("reads the exact bytes of a listed binary file, and refuses one over the limit", async () => {
    // Every byte value, so a text decode would change the result.
    const image = Buffer.alloc(600 * 1024)
    for (let i = 0; i < image.length; i++) image[i] = (i * 7) % 256
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, ".gitignore"), ".env\n")
        writeFileSync(join(directory, "logo.png"), image)
      },
      async ({ directory, handle }) => {
        writeFileSync(join(directory, ".env"), "API_KEY=hidden\n")
        symlinkSync("logo.png", join(directory, "logo-link.png"))
        const read = (path: string, max = 1024 * 1024) =>
          readConversationSandboxFileBytes(handle, path, max)
        const bytes = await read("logo.png")
        expect({
          same:
            bytes.kind === "bytes" && Buffer.from(bytes.bytes).equals(image),
          blob: await readConversationSandboxFile(handle, "logo.png"),
          tooLarge: await read("logo.png", image.length - 1),
          ignored: await read(".env"),
          symlink: await read("logo-link.png"),
          gitMetadata: await read(".git/config"),
          missing: await read("missing.png"),
        }).toEqual({
          same: true,
          blob: {
            path: "logo.png",
            body: null,
            binary: true,
            size: image.length,
          },
          tooLarge: { kind: "too_large", size: image.length },
          ignored: { kind: "missing" },
          symlink: { kind: "missing" },
          gitMetadata: { kind: "missing" },
          missing: { kind: "missing" },
        })
      },
    )
  })

  it("reads the bytes of a top-level file whose name starts with a dash", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "-x"), "dash bytes\n")
      },
      async ({ handle }) => {
        const result = await readConversationSandboxFileBytes(
          handle,
          "-x",
          1024,
        )
        expect(
          result.kind === "bytes" && Buffer.from(result.bytes).toString(),
        ).toBe("dash bytes\n")
      },
    )
  })

  it("refuses a read when the file changes between the size check and the read", async () => {
    await withWorktree(
      (directory) => writeFileSync(join(directory, "logo.png"), "png"),
      async ({ handle }) => {
        // The file grows inside the one read command, after its size check.
        const growing: JobSandboxHandle = {
          ...handle,
          exec: (command, options) =>
            handle.exec(
              command.replace(
                "head -c",
                'printf more >> "$CTXPIPE_FILE_PATH"; head -c',
              ),
              options,
            ),
        }
        await expect(
          readConversationSandboxFileBytes(growing, "logo.png", 1024),
        ).rejects.toBeInstanceOf(ConversationFileChangedError)
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
              await conversationBaseDiff({ handle, defaultBranch: "main" })
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

        const diff = await conversationBaseDiff({
          handle,
          defaultBranch: "main",
        })

        expect(diff.find((file) => file.path === ".env")).toMatchObject({
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

describe("conversation sandbox writes", { timeout: 15_000 }, () => {
  it("refuses writes, renames and deletes into git metadata", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "notes.md"), "notes\n")
        mkdirSync(join(directory, "vendor/lib/.git"), { recursive: true })
      },
      async ({ directory, handle }) => {
        const config = readFileSync(join(directory, ".git/config"), "utf8")
        for (const path of [
          ".git/config",
          ".git/hooks/x",
          ".GIT/config",
          "vendor/lib/.git/config",
        ]) {
          await expect(
            writeConversationSandboxFile({ handle, path, body: "x\n" }),
          ).rejects.toThrow(/Unsafe path/)
        }
        await expect(
          renameConversationSandboxPath({
            handle,
            from: "notes.md",
            to: ".git/hooks/x",
          }),
        ).rejects.toThrow(/Unsafe path/)
        await expect(
          removeConversationSandboxPath({ handle, path: ".git/config" }),
        ).rejects.toThrow(/Unsafe path/)
        expect(readFileSync(join(directory, ".git/config"), "utf8")).toBe(
          config,
        )
        expect(existsSync(join(directory, ".git/hooks/x"))).toBe(false)
        expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe(
          "notes\n",
        )
      },
    )
  })

  it("refuses writes through a symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ctxpipe-outside-"))
    try {
      writeFileSync(join(outside, "target.md"), "outside\n")
      await withWorktree(
        (directory) => {
          writeFileSync(join(directory, "notes.md"), "notes\n")
          symlinkSync(outside, join(directory, "linked-dir"))
          symlinkSync(join(outside, "target.md"), join(directory, "linked.md"))
        },
        async ({ handle }) => {
          for (const path of [
            "linked-dir/target.md",
            "linked-dir/new/file.md",
            "linked.md",
          ]) {
            await expect(
              writeConversationSandboxFile({ handle, path, body: "x\n" }),
            ).rejects.toThrow(/Unsafe path/)
          }
          await expect(
            renameConversationSandboxPath({
              handle,
              from: "notes.md",
              to: "linked-dir/notes.md",
            }),
          ).rejects.toThrow(/Unsafe path/)
          expect(readFileSync(join(outside, "target.md"), "utf8")).toBe(
            "outside\n",
          )
          expect(existsSync(join(outside, "new"))).toBe(false)
          expect(existsSync(join(outside, "notes.md"))).toBe(false)
        },
      )
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it("writes new, nested, and existing files", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "notes.md"), "old\n")
      },
      async ({ directory, handle }) => {
        await writeConversationSandboxFile({
          handle,
          path: "notes.md",
          body: "new\n",
        })
        await writeConversationSandboxFile({
          handle,
          path: "docs/deep/guide.md",
          body: "guide\n",
        })
        await writeConversationSandboxFile({
          handle,
          path: ".github/workflows/ci.yml",
          body: "on: push\n",
        })
        expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("new\n")
        expect(
          readFileSync(join(directory, "docs/deep/guide.md"), "utf8"),
        ).toBe("guide\n")
        expect(
          readFileSync(join(directory, ".github/workflows/ci.yml"), "utf8"),
        ).toBe("on: push\n")
      },
    )
  })

  it("runs no program from the repository config in backend git commands", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "notes.md"), "notes\n")
        writeFileSync(
          join(directory, ".gitattributes"),
          "*.md filter=planted.one diff=planted\n",
        )
      },
      async ({ directory, handle, git }) => {
        const ran = join(directory, ".git", "ran")
        const program = (name: string, then: string) => {
          const script = join(directory, ".git", `${name}.sh`)
          writeFileSync(
            script,
            `#!/bin/sh\necho ${name} >> '${ran}'\n${then}\n`,
            {
              mode: 0o755,
            },
          )
          return script
        }
        const runs = () =>
          existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : []
        git("config", "core.fsmonitor", program("fsmonitor", "exit 1"))
        git("config", "core.hooksPath", join(directory, ".git", "planted"))
        git("config", "diff.external", program("external", "exit 0"))
        git("config", "diff.planted.textconv", program("textconv", 'cat "$1"'))
        git("config", "filter.planted.one.clean", program("clean", "cat"))
        git("config", "filter.planted.one.smudge", program("smudge", "cat"))
        git("config", "filter.planted.one.required", "true")
        writeFileSync(join(directory, "notes.md"), "changed\n")
        // A plain git command runs the planted programs.
        git("status", "--porcelain")
        git("diff", "HEAD")
        git("diff", "--no-ext-diff", "HEAD")
        expect(runs()).toEqual(
          expect.arrayContaining([
            "fsmonitor",
            "clean",
            "external",
            "textconv",
          ]),
        )
        rmSync(ran)
        const sandbox = adaptTanstackHandle({
          process: { exec: handle.exec },
          fs: handle.fs,
          destroy: async () => {},
        })
        const status = await conversationSandboxStatus({
          handle: sandbox,
          defaultBranch: "main",
          sessionBranch: "ctxpipe/session",
        })
        expect(status.items).toEqual([
          expect.objectContaining({ path: "notes.md", status: "modified" }),
        ])
        await conversationWorktreeVersion(sandbox)
        const diff = await sandbox.exec(
          "git diff --no-ext-diff --no-textconv HEAD",
        )
        expect(diff.stdout).toContain("+changed")
        expect(runs()).toEqual([])
        const hooks = await sandbox.exec("git config core.hooksPath")
        expect(hooks.stdout.trim()).toBe("/dev/null")
      },
    )
  })

  it("runs no merge driver from the repository config in a backend rebase", async () => {
    await withWorktree(
      (directory) => {
        writeFileSync(join(directory, "notes.md"), "1\n2\n3\n4\n5\n")
        writeFileSync(
          join(directory, ".gitattributes"),
          "*.md merge=planted.m\n",
        )
      },
      async ({ directory, handle, git }) => {
        const ran = join(directory, ".git", "ran")
        const script = join(directory, ".git", "merge.sh")
        writeFileSync(script, `#!/bin/sh\necho merge >> '${ran}'\nexit 0\n`, {
          mode: 0o755,
        })
        git("config", "merge.planted.m.driver", `${script} %A %O %B`)
        git("checkout", "-q", "-b", "side")
        writeFileSync(join(directory, "notes.md"), "one\n2\n3\n4\n5\n")
        git("commit", "-q", "-am", "Side")
        git("checkout", "-q", "main")
        writeFileSync(join(directory, "notes.md"), "1\n2\n3\n4\nfive\n")
        git("commit", "-q", "-am", "Main")
        git("checkout", "-q", "side")
        // A plain git merge runs the planted driver.
        git("merge-tree", "--write-tree", "main", "side")
        expect(existsSync(ran)).toBe(true)
        rmSync(ran)
        const sandbox = adaptTanstackHandle({
          process: { exec: handle.exec },
          fs: handle.fs,
          destroy: async () => {},
        })
        const rebased = await sandbox.exec(
          "git -c user.name=t -c user.email=t@example.test rebase -q main",
        )
        expect(rebased.exitCode).toBe(0)
        expect(existsSync(ran)).toBe(false)
        // The built-in text merge keeps both changes.
        expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe(
          "one\n2\n3\n4\nfive\n",
        )
      },
    )
  })
})
