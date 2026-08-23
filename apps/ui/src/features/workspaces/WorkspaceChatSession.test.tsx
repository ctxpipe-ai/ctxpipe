import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ChatMessage } from "@/features/chat/types"
import { readOnlyWorkspace } from "./workspace-fixtures"

const useChatState = vi.hoisted(() => ({
  messages: [] as ChatMessage[],
  status: "error" as const,
  isLoading: false,
  error: new Error(
    "opencode serve exited before becoming ready: sh: opencode: not found",
  ) as Error | null,
}))

const navigateMock = vi.hoisted(() => vi.fn())

vi.mock("@tanstack/ai-react", () => ({
  useChat: () => ({
    messages: useChatState.messages,
    sendMessage: vi.fn(),
    status: useChatState.status,
    isLoading: useChatState.isLoading,
    error: useChatState.error,
    stop: vi.fn(),
  }),
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

import {
  WorkspaceChatSession,
  workspaceChatHasAssistantText,
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

describe("WorkspaceChatSession compose failure", () => {
  beforeEach(() => {
    navigateMock.mockReset()
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
})
