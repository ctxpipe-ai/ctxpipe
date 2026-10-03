import { describe, expect, it } from "vitest"
import {
  chatPullRequestPathIsSafe,
  checkoutPublishedChatBranch,
  collectChatPullRequestTree,
  isChatSessionBranch,
  splitGitNulPaths,
} from "./chat-pull-request.js"

describe("chat pull request tree", () => {
  it("splits NUL-delimited git paths including names with spaces", () => {
    expect(splitGitNulPaths("knowledge/a file.md\0linear/issue.md\0")).toEqual([
      "knowledge/a file.md",
      "linear/issue.md",
    ])
    expect(splitGitNulPaths("")).toEqual([])
  })

  it("refuses path traversal", () => {
    expect(chatPullRequestPathIsSafe("knowledge/a.md")).toBe(true)
    expect(chatPullRequestPathIsSafe("knowledge/a file.md")).toBe(true)
    expect(chatPullRequestPathIsSafe("../secret")).toBe(false)
    expect(chatPullRequestPathIsSafe("/etc/passwd")).toBe(false)
    expect(chatPullRequestPathIsSafe("foo/../bar")).toBe(false)
  })

  it("reads dirty files from git -z plumbing instead of porcelain", async () => {
    const commands: string[] = []
    const files = new Map([
      ["knowledge/a file.md", "hello"],
      ["linear/new.md", "issue"],
    ])
    const collected = await collectChatPullRequestTree({
      exec: async (command) => {
        commands.push(command)
        if (command.includes("--diff-filter=ACMRTUXB")) {
          return {
            stdout: "knowledge/a file.md\0",
            stderr: "",
            exitCode: 0,
          }
        }
        if (command.includes("--diff-filter=D")) {
          return { stdout: "knowledge/gone.md\0", stderr: "", exitCode: 0 }
        }
        if (command.includes("ls-files")) {
          return { stdout: "linear/new.md\0", stderr: "", exitCode: 0 }
        }
        if (command.startsWith("find ")) {
          return { stdout: "", stderr: "", exitCode: 0 }
        }
        throw new Error(command)
      },
      fs: {
        write: async () => undefined,
        read: async (path) => {
          const content = files.get(path)
          if (content == null) throw new Error(`missing ${path}`)
          return content
        },
        remove: async () => undefined,
        mkdir: async () => undefined,
      },
    })
    expect(
      commands
        .filter((command) => command.startsWith("git "))
        .every((command) => command.includes("-z")),
    ).toBe(true)
    expect(commands.some((command) => command.includes("-print0"))).toBe(true)
    expect(commands.some((command) => command.includes("porcelain"))).toBe(
      false,
    )
    expect(collected).toEqual({
      files: [
        { path: "knowledge/a file.md", content: "hello" },
        { path: "linear/new.md", content: "issue" },
      ],
      deletePaths: ["knowledge/gone.md"],
    })
  })

  it("refuses symlink paths in the dirty tree", async () => {
    await expect(
      collectChatPullRequestTree({
        exec: async (command) => {
          if (command.startsWith("find ")) {
            return { stdout: "./secret\0", stderr: "", exitCode: 0 }
          }
          if (command.includes("--diff-filter=D")) {
            return { stdout: "", stderr: "", exitCode: 0 }
          }
          if (
            command.includes("ls-files") ||
            command.includes("--diff-filter=")
          ) {
            return { stdout: "secret\0", stderr: "", exitCode: 0 }
          }
          throw new Error(command)
        },
        fs: {
          write: async () => undefined,
          read: async () => "leaked",
          remove: async () => undefined,
          mkdir: async () => undefined,
        },
      }),
    ).rejects.toThrow(/Unsafe path/)
  })

  it("checks out the published session branch and commits remaining dirtiness", async () => {
    const commands: string[] = []
    await checkoutPublishedChatBranch({
      branch: "ctxpipe/chat/conv_1/3",
      handle: {
        exec: async (command) => {
          commands.push(command)
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
    expect(isChatSessionBranch("ctxpipe/chat/conv_1/3")).toBe(true)
    expect(isChatSessionBranch("main")).toBe(false)
    expect(commands[0]).toBe("git checkout -B ctxpipe/chat/conv_1/3")
    expect(commands[1]).toBe("git add -A")
    await expect(
      checkoutPublishedChatBranch({
        branch: "main",
        handle: {
          exec: async () => {
            throw new Error("should not exec")
          },
          fs: {
            write: async () => undefined,
            read: async () => "",
            remove: async () => undefined,
            mkdir: async () => undefined,
          },
        },
      }),
    ).rejects.toThrow(/Refusing/)
  })
})
