import { describe, expect, it, vi } from "vitest"
import { withTestLogger } from "../../test/with-test-logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import {
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
  it("throws when a Docker sandbox still has a listener on 4096", async () => {
    const exec = vi.fn(async () => ({
      stdout: "",
      stderr: "",
      exitCode: 0,
    }))
    await expect(
      preflightChatSandbox({
        handle: chatHandle({ exec }),
        isolation: "docker",
        proxyUrl: "http://127.0.0.1:1",
        stalePort: 4096,
      }),
    ).rejects.toThrow("still has a listener on port 4096")
  })

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
