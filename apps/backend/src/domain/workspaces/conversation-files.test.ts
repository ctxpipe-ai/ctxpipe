import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import {
  conversationWorktreeVersion,
  ensureConversationSessionBranch,
  fingerprintConversationWorktree,
  listConversationSandboxPaths,
  sanitizeGitRemoteError,
} from "./conversation-files.js"

function fakeHandle(
  commands: string[],
  answers: Record<string, string>,
  optionsLog?: Array<{ env?: Record<string, string> }>,
  files: Record<string, string> = {},
) {
  return {
    exec: async (
      command: string,
      options?: { env?: Record<string, string> },
    ) => {
      commands.push(command)
      optionsLog?.push(options ?? {})
      for (const [needle, stdout] of Object.entries(answers)) {
        if (command.includes(needle)) {
          return { stdout, stderr: "", exitCode: 0 }
        }
      }
      return { stdout: "", stderr: "", exitCode: 0 }
    },
    fs: {
      write: async () => undefined,
      read: async (path: string) => files[path] ?? "",
      remove: async () => undefined,
      mkdir: async () => undefined,
    },
  }
}

describe("conversation sandbox files", () => {
  it("checks out the one session branch", async () => {
    const commands: string[] = []
    const branch = await ensureConversationSessionBranch({
      conversationId: "conv_1",
      defaultBranch: "main",
      handle: fakeHandle(commands, {}),
    })
    expect(branch).toBe("ctxpipe/chat/conv_1/1")
    expect(commands).toEqual([
      "git branch --show-current",
      "git checkout -B ctxpipe/chat/conv_1/1",
    ])
  })

  it("skips checkout when HEAD is already the session branch", async () => {
    const commands: string[] = []
    const branch = await ensureConversationSessionBranch({
      conversationId: "conv_1",
      defaultBranch: "main",
      handle: fakeHandle(commands, {
        "git branch --show-current": "ctxpipe/chat/conv_1/1\n",
      }),
    })
    expect(branch).toBe("ctxpipe/chat/conv_1/1")
    expect(commands).toEqual(["git branch --show-current"])
  })

  it("does not wipe sandbox PATH with an empty exec env", async () => {
    const commands: string[] = []
    const optionsLog: Array<{ env?: Record<string, string> }> = []
    await ensureConversationSessionBranch({
      conversationId: "conv_1",
      defaultBranch: "main",
      handle: fakeHandle(commands, {}, optionsLog),
    })
    expect(optionsLog[0]?.env).toBeUndefined()
  })

  it("lists tracked and untracked paths", async () => {
    const paths = await listConversationSandboxPaths(
      fakeHandle([], {
        "git ls-files -z": "AGENTS.md\0knowledge/a.md\0",
        "git ls-files --others": "new.md\0",
      }),
    )
    expect(paths).toEqual(["AGENTS.md", "knowledge/a.md", "new.md"])
  })

  it("omits OpenCode and TanStack harness paths from the listing", async () => {
    const paths = await listConversationSandboxPaths(
      fakeHandle([], {
        "git ls-files -z":
          "AGENTS.md\0opencode.json\0tm/tanstack-ai-sa/x/.tanstack-projected-foo\0",
        "git ls-files --others":
          "e2e.md\0.tanstack-projected-bar\0tmp/tanstack-ai-sandboxes/x\0",
      }),
    )
    expect(paths).toEqual(["AGENTS.md", "e2e.md"])
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

  it("reads a worktree version without staging or writing a tree", async () => {
    const commands: string[] = []
    const version = await conversationWorktreeVersion(
      fakeHandle(
        commands,
        {
          "git rev-parse HEAD": "abc123\n",
          "git diff HEAD": "diff --git a/notes.md\n+hello\n",
          "git ls-files --others": "new.md\0opencode.json\0",
        },
        undefined,
        { "new.md": "fresh" },
      ),
    )
    expect(version).toBe(
      fingerprintConversationWorktree({
        headSha: "abc123",
        trackedDiff: "diff --git a/notes.md\n+hello\n",
        untracked: [
          {
            path: "new.md",
            digest: createHash("sha256").update("fresh").digest("hex"),
          },
        ],
      }),
    )
    expect(commands.some((command) => command.includes("git add"))).toBe(false)
    expect(commands.some((command) => command.includes("write-tree"))).toBe(
      false,
    )
  })
})
