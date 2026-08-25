import { describe, expect, it, vi } from "vitest"
import { withTestLogger } from "../../test/with-test-logger.js"
import type { TanstackLikeHandle } from "./job-sandbox.js"
import { invalidateChatSandbox } from "./workspace-chat-sandbox-health.js"

function chatHandle(input: {
  destroy?: TanstackLikeHandle["destroy"]
}): TanstackLikeHandle {
  return {
    process: {
      exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
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
  vi.fn(async (): Promise<Array<{ id: string }>> => [{ id: "sbx_1" }]),
)

vi.mock("../../db/client.js", () => ({
  withOrgDbContext: async (_orgId: string, fn: () => unknown) => fn(),
}))

vi.mock("../../models/workspaces.js", () => ({
  deleteSandboxInstance,
  listSandboxInstances,
}))

describe("invalidateChatSandbox", () => {
  it("destroys the handle and deletes instance rows", async () => {
    const destroy = vi.fn(async () => {})
    await withTestLogger(() =>
      invalidateChatSandbox({
        handle: chatHandle({ destroy }),
        orgId: "org_1",
        conversationId: "conv_1",
      }),
    )
    expect(destroy).toHaveBeenCalled()
    expect(deleteSandboxInstance).toHaveBeenCalledWith("sbx_1", "org_1")
  })
})
