import { describe, expect, it } from "vitest"
import {
  chromePullRequestAction,
  conversationGithubPullUrl,
  conversationPushRemoteUrl,
  pushConversationSessionBranch,
  shellSingleQuote,
} from "./conversation-publish.js"

describe("conversation publish", () => {
  it("quotes commit messages for the leftover commit", () => {
    expect(shellSingleQuote("Repo layout")).toBe("'Repo layout'")
    expect(shellSingleQuote("it's fine")).toBe("'it'\\''s fine'")
  })

  it("builds a tokenized push remote without leaving the token in chrome URLs", () => {
    expect(
      conversationPushRemoteUrl({
        repositoryName: "acme/docs",
        token: "tok",
      }),
    ).toBe("https://x-access-token:tok@github.com/acme/docs.git")
    expect(
      conversationGithubPullUrl({ repositoryName: "acme/docs", prNumber: 41 }),
    ).toBe("https://github.com/acme/docs/pull/41")
  })

  it("returns Create PR after a merged or closed PR", () => {
    expect(chromePullRequestAction("open")).toBe("show")
    expect(chromePullRequestAction("merged")).toBe("create")
    expect(chromePullRequestAction(null)).toBe("create")
  })

  it("pushes leftover commits on the session branch only", async () => {
    const commands: string[] = []
    const result = await pushConversationSessionBranch({
      conversationId: "conv_1",
      defaultBranch: "main",
      repositoryName: "acme/docs",
      token: "tok",
      commitMessage: "Repo layout",
      handle: {
        exec: async (command) => {
          commands.push(command)
          if (command.includes("git status --porcelain")) {
            return { stdout: "", stderr: "", exitCode: 0 }
          }
          if (command.includes("git rev-list --left-right")) {
            return { stdout: "0\t1", stderr: "", exitCode: 0 }
          }
          if (command.includes("origin/ctxpipe/chat/conv_1/1..HEAD")) {
            return { stdout: "1", stderr: "", exitCode: 0 }
          }
          if (command.includes("nothing to commit")) {
            return { stdout: "nothing to commit", stderr: "", exitCode: 1 }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
      },
    })
    expect(result).toEqual({
      ok: true,
      branch: "ctxpipe/chat/conv_1/1",
      pushed: true,
    })
    expect(
      commands.some((command) =>
        command.includes(
          "git push --force-with-lease https://x-access-token:tok@github.com/acme/docs.git HEAD:refs/heads/ctxpipe/chat/conv_1/1",
        ),
      ),
    ).toBe(true)
    expect(
      commands.some((command) => command.includes("git checkout -B ctxpipe/chat/conv_1/1")),
    ).toBe(true)
  })

  it("refuses to push when there is nothing vs default and nothing unpushed", async () => {
    const result = await pushConversationSessionBranch({
      conversationId: "conv_1",
      defaultBranch: "main",
      repositoryName: "acme/docs",
      token: "tok",
      commitMessage: "Repo layout",
      handle: {
        exec: async (command) => {
          if (command.includes("git commit")) {
            return {
              stdout: "nothing to commit, working tree clean",
              stderr: "",
              exitCode: 1,
            }
          }
          if (command.includes("git rev-list --left-right")) {
            return { stdout: "0\t0", stderr: "", exitCode: 0 }
          }
          if (command.includes("origin/ctxpipe/chat/conv_1/1..HEAD")) {
            return { stdout: "0", stderr: "", exitCode: 0 }
          }
          return { stdout: "", stderr: "", exitCode: 0 }
        },
        fs: {
          write: async () => undefined,
          read: async () => "",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
      },
    })
    expect(result).toEqual({ ok: false, error: "no_changes" })
  })
})
