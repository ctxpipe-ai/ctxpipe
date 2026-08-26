import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  forgetConversationSandboxDefinition,
  memoizedChatProvider,
  memoizedConversationSandbox,
  resetWorkspaceChatSandboxMemos,
} from "./workspace-chat-sandbox-memo.js"

describe("workspace chat sandbox memos", () => {
  beforeEach(() => {
    resetWorkspaceChatSandboxMemos()
  })

  it("reuses one provider and does not cache a missing factory", () => {
    const create = vi.fn(() => "local-provider")
    expect(memoizedChatProvider("unsandboxed", create)).toBe("local-provider")
    expect(memoizedChatProvider("unsandboxed", create)).toBe("local-provider")
    expect(create).toHaveBeenCalledTimes(1)

    const missing = vi.fn(() => undefined)
    expect(memoizedChatProvider("docker", missing)).toBeUndefined()
    expect(memoizedChatProvider("docker", missing)).toBeUndefined()
    expect(missing).toHaveBeenCalledTimes(2)

    const later = vi.fn(() => "docker-provider")
    expect(memoizedChatProvider("docker", later)).toBe("docker-provider")
    expect(later).toHaveBeenCalledTimes(1)
  })

  it("reuses one definition object per conversation until spec or isolation changes", () => {
    const create = vi.fn((handle) => {
      handle.current = { id: "sbx_1" } as (typeof handle)["current"]
      return { id: "def_1" }
    })
    const first = memoizedConversationSandbox({
      conversationId: "conv_1",
      specId: "spec_a",
      isolation: "unsandboxed",
      create,
    })
    const second = memoizedConversationSandbox({
      conversationId: "conv_1",
      specId: "spec_a",
      isolation: "unsandboxed",
      create,
    })
    expect(create).toHaveBeenCalledTimes(1)
    expect(second.definition).toBe(first.definition)
    expect(second.handle).toBe(first.handle)
    expect(second.handle.current?.id).toBe("sbx_1")

    const rebuilt = memoizedConversationSandbox({
      conversationId: "conv_1",
      specId: "spec_b",
      isolation: "unsandboxed",
      create: () => ({ id: "def_2" }),
    })
    expect(rebuilt.definition).toEqual({ id: "def_2" })
    expect(rebuilt.definition).not.toBe(first.definition)

    const other = memoizedConversationSandbox({
      conversationId: "conv_2",
      specId: "spec_a",
      isolation: "unsandboxed",
      create: () => ({ id: "def_other" }),
    })
    expect(other.definition).toEqual({ id: "def_other" })
    expect(other.definition).not.toBe(first.definition)
  })

  it("drops the conversation definition so the next turn rebuilds", () => {
    const create = vi.fn(() => ({ id: "def_1" }))
    memoizedConversationSandbox({
      conversationId: "conv_1",
      specId: "spec_a",
      isolation: "docker",
      create,
    })
    forgetConversationSandboxDefinition("conv_1")
    const next = memoizedConversationSandbox({
      conversationId: "conv_1",
      specId: "spec_a",
      isolation: "docker",
      create,
    })
    expect(create).toHaveBeenCalledTimes(2)
    expect(next.definition).toEqual({ id: "def_1" })
  })
})
