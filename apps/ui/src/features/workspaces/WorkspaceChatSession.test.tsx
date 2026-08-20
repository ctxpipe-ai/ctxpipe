import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"
import { readOnlyWorkspace } from "./workspace-fixtures"

vi.mock("@ai-sdk/react", () => ({
  useChat: () => ({
    messages: [],
    sendMessage: vi.fn(),
    status: "error",
    error: new Error(
      "opencode serve exited before becoming ready: sh: opencode: not found",
    ),
    stop: vi.fn(),
  }),
}))

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => vi.fn(),
}))

vi.mock("@/features/chat/MessageInputBox", () => ({
  MessageInputBox: () => <div>Ask about this Workspace…</div>,
}))

vi.mock("@/components/OverlayNavButton", () => ({
  OverlayNavMenuButton: () => null,
}))

import { WorkspaceChatSession } from "./WorkspaceChatSession"

describe("WorkspaceChatSession compose failure", () => {
  it("shows the harness error on a read-only compose instead of going blank", () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    const markup = renderToStaticMarkup(
      <QueryClientProvider client={queryClient}>
        <WorkspaceChatSession
          orgSlug="acme"
          workspace={readOnlyWorkspace}
          conversationId="conv_pending"
          composing
          title="New conversation"
          initialMessages={[]}
        />
      </QueryClientProvider>,
    )
    expect(markup).toMatch(/opencode: not found/)
    expect(markup).toMatch(/Ask about this Workspace/)
  })
})
