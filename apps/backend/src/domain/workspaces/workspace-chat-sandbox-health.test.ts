import { describe, expect, it, vi } from "vitest"
import { withTestLogger } from "../../test/with-test-logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import {
  ensureChatSandboxCheckout,
  invalidateChatSandbox,
  preflightChatSandbox,
  streamSawOpenCodeSession,
} from "./workspace-chat-sandbox-health.js"

function chatHandle(input: {
  exec?: TanstackLikeHandle["process"]["exec"]
  destroy?: TanstackLikeHandle["destroy"]
}): TanstackLikeHandle {
  return {
    process: {
      exec:
        input.exec ??
        (async () => ({ stdout: "", stderr: "", exitCode: 0 })),
    },
    fs: {
      write: async () => undefined,
      read: async () => "",
      remove: async () => undefined,
      mkdir: async () => undefined,
    },
    destroy: input.destroy ?? (async () => {}),
  }
}

const deleteSandboxInstance = vi.hoisted(() => vi.fn(async () => {}))
const listSandboxInstances = vi.hoisted(() =>
  vi.fn(async (): Promise<Array<{ id: string }>> => []),
)

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => fn(),
}))

vi.mock("../../models/workspaces.js", () => ({
  deleteSandboxInstance,
  listSandboxInstances,
}))

describe("preflightChatSandbox", () => {
  it("does not throw when git or the OpenCode CLI is missing", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }))
    await expect(
      withTestLogger(() =>
        preflightChatSandbox({
          handle: chatHandle({ exec }),
          isolation: "local_process",
          proxyUrl: "http://127.0.0.1:1",
        }),
      ),
    ).resolves.toBeUndefined()
  })

  it("does not curl the model proxy from inside the sandbox", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 1,
    }))
    await expect(
      withTestLogger(() =>
        preflightChatSandbox({
          handle: chatHandle({ exec }),
          isolation: "local_process",
          proxyUrl: "http://127.0.0.1:9",
        }),
      ),
    ).resolves.toBeUndefined()
    expect(exec.mock.calls.join("\n")).not.toContain("/v1/models")
  })
})

describe("ensureChatSandboxCheckout", () => {
  it("clones into a temp dir and does not put the token on argv", async () => {
    const exec = vi.fn(
      async (
        _command?: string,
        _options?: { cwd?: string; env?: Record<string, string> },
      ) => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    )
    await ensureChatSandboxCheckout({
      handle: chatHandle({ exec }),
      repoUrl: "https://github.com/acme/docs.git",
      defaultBranch: "main",
      desiredSha: "abc123",
    })
    expect(exec).toHaveBeenCalledTimes(1)
    const [command, options] = exec.mock.calls[0] ?? []
    expect(String(command)).toContain("/tmp/ctxpipe-repo-clone")
    expect(String(command)).toContain("credential.helper")
    expect(String(command)).toContain("${CTXPIPE_CLONE_TOKEN}")
    expect(String(command)).not.toContain("ghs_")
    expect(String(command)).not.toContain("github_pat_")
    expect(options).toEqual({
      env: {
        CTXPIPE_CLONE_URL: "https://github.com/acme/docs.git",
        CTXPIPE_CLONE_BRANCH: "main",
        CTXPIPE_CLONE_SHA: "abc123",
      },
    })
  })

  it("throws when the checkout script fails", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "fatal: repository not found",
      exitCode: 128,
    }))
    await expect(
      ensureChatSandboxCheckout({
        handle: chatHandle({ exec }),
        repoUrl: "https://github.com/acme/docs",
        defaultBranch: "main",
      }),
    ).rejects.toThrow("workspace chat git clone failed")
  })
})

describe("invalidateChatSandbox", () => {
  it("destroys the handle and deletes the opaque key", async () => {
    const destroy = vi.fn(async () => {})
    listSandboxInstances.mockResolvedValueOnce([{ id: "opaque-key" }])
    await withTestLogger(() =>
      invalidateChatSandbox({
        handle: chatHandle({ destroy }),
        orgId: "org_1",
        conversationId: "conv_1",
      }),
    )
    expect(destroy).toHaveBeenCalled()
    expect(deleteSandboxInstance).toHaveBeenCalledWith("opaque-key", "org_1")
  })
})

describe("streamSawOpenCodeSession", () => {
  it("recognizes the official session-id custom event", () => {
    expect(
      streamSawOpenCodeSession({
        type: "CUSTOM",
        name: "opencode.session-id",
        value: { sessionId: "ses_1" },
      }),
    ).toBe(true)
    expect(streamSawOpenCodeSession({ type: "TEXT_MESSAGE_CONTENT" })).toBe(
      false,
    )
  })
})
