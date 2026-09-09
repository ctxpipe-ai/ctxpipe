import { describe, expect, it } from "vitest"
import {
  ensureConversationSessionBranch,
  listConversationSandboxPaths,
  sanitizeGitRemoteError,
} from "./conversation-files.js"

function fakeHandle(
  commands: string[],
  answers: Record<string, string>,
  optionsLog?: Array<{ env?: Record<string, string> }>,
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
      read: async () => "",
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
})
