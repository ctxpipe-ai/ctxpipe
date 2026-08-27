import type { StreamChunk } from "@tanstack/ai"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage, ChatStatus } from "@/features/chat/types"
import { readOnlyWorkspace } from "./workspace-fixtures"

const useChatState = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  status: "error" as ChatStatus,
  isLoading: false,
  error: new Error(
    "opencode serve exited before becoming ready: sh: opencode: not found",
  ) as Error | null,
}))

const navigateMock = vi.hoisted(() => vi.fn())
const workspaceChatWebSocketMock = vi.hoisted(() =>
  vi.fn(() => ({ kind: "official-ws", warm: vi.fn() })),
)
const useChatMock = vi.hoisted(() =>
  vi.fn((_options?: Record<string, unknown>) => ({
    messages: useChatState.messages,
    sendMessage: vi.fn(),
    status: useChatState.status,
    isLoading: useChatState.isLoading,
    error: useChatState.error,
    stop: vi.fn(),
  })),
)

vi.mock("@tanstack/ai-react", () => ({
  useChat: useChatMock,
}))

vi.mock("./workspaceChatWebSocket", () => ({
  workspaceChatWebSocket: workspaceChatWebSocketMock,
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => navigateMock,
}))

vi.mock("@/features/chat/MessageInputBox", () => ({
  MessageInputBox: () => <div>Ask about this Workspace…</div>,
}))

vi.mock("@/components/OverlayNavButton", () => ({
  OverlayNavMenuButton: () => null,
}))

vi.mock("./queries", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./queries")>()
  return {
    ...actual,
    prepareWorkspaceChat: vi.fn(async () => undefined),
  }
})

import {
  sandboxPhaseFromChunk,
  WorkspaceChatSession,
  workspaceChatHasAssistantText,
  workspaceChatWaitLabel,
} from "./WorkspaceChatSession"

function renderCompose(initialMessages: ChatMessage[] = []) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <WorkspaceChatSession
        orgSlug="acme"
        workspace={readOnlyWorkspace}
        conversationId="conv_pending"
        composing
        title="New conversation"
        initialMessages={initialMessages}
      />
    </QueryClientProvider>,
  )
}

describe("workspace chat wait copy", () => {
  it("defaults to Thinking and only names the sandbox while it is starting", () => {
    expect(workspaceChatWaitLabel("idle")).toBe("Thinking…")
    expect(workspaceChatWaitLabel("ready")).toBe("Thinking…")
    expect(workspaceChatWaitLabel("starting")).toBe("Setting up sandbox")
  })

  it("reads sandbox-setup CUSTOM chunks and ignores other events", () => {
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "sandbox-setup",
        value: { phase: "starting" },
        timestamp: 1,
      } as StreamChunk),
    ).toBe("starting")
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "sandbox-setup",
        value: { phase: "ready" },
        timestamp: 1,
      } as StreamChunk),
    ).toBe("ready")
    expect(
      sandboxPhaseFromChunk({
        type: "CUSTOM",
        name: "rename-conversation",
        value: { name: "Ledger" },
        timestamp: 1,
      } as StreamChunk),
    ).toBeNull()
    expect(
      sandboxPhaseFromChunk({
        type: "RUN_STARTED",
        threadId: "conv_1",
        runId: "run_1",
        timestamp: 1,
      } as StreamChunk),
    ).toBeNull()
  })
})

describe("WorkspaceChatSession compose failure", () => {
  beforeEach(() => {
    navigateMock.mockReset()
    workspaceChatWebSocketMock.mockClear()
    useChatMock.mockClear()
    useChatState.messages = []
    useChatState.status = "error"
    useChatState.isLoading = false
    useChatState.error = new Error(
      "opencode serve exited before becoming ready: sh: opencode: not found",
    )
  })

  it("shows the harness error on a read-only compose instead of going blank", () => {
    const markup = renderCompose()
    expect(markup).toMatch(/opencode: not found/)
    expect(markup).toMatch(/Ask about this Workspace/)
  })

  it("paints stored turns in the first HTML", () => {
    useChatState.status = "ready"
    useChatState.error = null
    useChatState.messages = [
      {
        id: "conv_stored:0",
        role: "user",
        parts: [{ type: "text", content: "stored user turn" }],
      },
      {
        id: "conv_stored:1",
        role: "assistant",
        parts: [{ type: "text", content: "stored assistant turn" }],
      },
    ]
    const markup = renderCompose(useChatState.messages)
    expect(markup).toMatch(/stored user turn/)
    expect(markup).toMatch(/stored assistant turn/)
  })

  it("keeps the compose error after a fake streaming status with no assistant text", () => {
    useChatState.status = "error"
    useChatState.error = new Error(
      "Unexpected server error. Check server logs for details.",
    )
    const markup = renderCompose()
    expect(markup).toMatch(/Unexpected server error/)
    expect(markup).toMatch(/Ask about this Workspace/)
    expect(workspaceChatHasAssistantText(useChatState.messages)).toBe(false)
  })

  it("does not treat streaming-without-tokens as a reason to leave compose", () => {
    expect(
      workspaceChatHasAssistantText([
        { role: "user", parts: [{ type: "text", content: "hello" }] },
      ]),
    ).toBe(false)
    expect(
      workspaceChatHasAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "  " }] },
      ]),
    ).toBe(false)
    expect(
      workspaceChatHasAssistantText([
        { role: "assistant", parts: [{ type: "text", content: "Hi" }] },
      ]),
    ).toBe(true)
  })

  it("pairs useChat with official websocket on the conversation path", () => {
    renderCompose()
    expect(workspaceChatWebSocketMock).toHaveBeenCalledTimes(1)
    expect(workspaceChatWebSocketMock).toHaveBeenCalledWith(
      "acme",
      "conv_pending",
    )
    expect(useChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_pending",
        persistence: true,
        connection: { kind: "official-ws", warm: expect.any(Function) },
        forwardedProps: {
          workspaceId: readOnlyWorkspace.id,
          source: "ui",
        },
      }),
    )
    expect(useChatMock.mock.calls[0]?.[0]).not.toHaveProperty("initialMessages")
    expect(navigateMock).not.toHaveBeenCalled()
  })

  it("hydrates a stored thread without seeding initialMessages", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceChatSession
          orgSlug="acme"
          workspace={readOnlyWorkspace}
          conversationId="conv_1"
          composing={false}
          title="Ledger"
        />
      </QueryClientProvider>,
    )
    expect(useChatMock).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "conv_1",
        persistence: true,
      }),
    )
    expect(useChatMock.mock.calls.at(-1)?.[0]).not.toHaveProperty(
      "initialMessages",
    )
  })

  it("paints one new assistant bubble on top of stored turns", () => {
    useChatState.status = "ready"
    useChatState.error = null
    useChatState.messages = [
      {
        id: "conv_stored:0",
        role: "user",
        parts: [{ type: "text", content: "stored user turn" }],
      },
      {
        id: "conv_stored:1",
        role: "assistant",
        parts: [{ type: "text", content: "stored assistant turn" }],
      },
      {
        id: "conv_stored:2",
        role: "user",
        parts: [{ type: "text", content: "second question" }],
      },
      {
        id: "conv_stored:3",
        role: "assistant",
        parts: [{ type: "text", content: "this-run reply" }],
      },
    ]
    const markup = renderCompose(useChatState.messages.slice(0, 2))
    expect(markup.match(/stored user turn/g)).toHaveLength(1)
    expect(markup.match(/stored assistant turn/g)).toHaveLength(1)
    expect(markup.match(/this-run reply/g)).toHaveLength(1)
  })
})
