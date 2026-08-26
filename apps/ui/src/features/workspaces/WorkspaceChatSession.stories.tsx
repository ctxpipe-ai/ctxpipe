import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { resetHomeDraftSends } from "@/features/home/pending-workspace-compose"
import {
  conversationAguiSseResponse,
  conversationAguiTextEvents,
  conversationPostPath,
} from "@/mocks/conversation-agui"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChatSession } from "./WorkspaceChatSession"
import {
  codeAnswerMessages,
  docsConversationDetail,
  docsWorkspace,
  longThreadMessages,
  manyToolMessages,
  markdownAnswerMessages,
  oneToolMessages,
  readOnlyWorkspace,
  reasoningAndToolsMessages,
  reasoningMessages,
  sourceLinkMessages,
  streamingReasoningAndToolsMessages,
  streamingReasoningMessages,
  streamingToolMessages,
} from "./workspace-fixtures"

const SEND_WAIT_MS = 5_000

const threadRoute = {
  pattern: "orgWorkspace",
  orgSlug: "acme",
  workspaceSlug: "docs",
  conversationId: "conv_1",
} satisfies StoryRouteParams

const meta = {
  title: "Components/Workspaces/ChatSession",
  component: WorkspaceChatSession,
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
    conversationId: "conv_pending",
    composing: true,
    title: "New conversation",
    initialMessages: [],
  },
} satisfies Meta<typeof WorkspaceChatSession>

export default meta

type Story = StoryObj<typeof meta>

function threadArgs(
  messages: typeof docsConversationDetail.messages,
  title = docsConversationDetail.conversation.name,
) {
  return {
    conversationId: "conv_1",
    composing: false,
    title,
    initialMessages: messages,
  }
}

export const ComposeEmpty: Story = {}

export const ThreadShort: Story = {
  args: threadArgs(docsConversationDetail.messages),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ThreadLong: Story = {
  args: threadArgs(longThreadMessages),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const MarkdownAnswer: Story = {
  args: threadArgs(markdownAnswerMessages, "Auth"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const CodeAnswer: Story = {
  args: threadArgs(codeAnswerMessages, "Session helper"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const Reasoning: Story = {
  args: threadArgs(reasoningMessages, "Ledger"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ReasoningStreaming: Story = {
  args: threadArgs(streamingReasoningMessages, "Ledger"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ToolUse: Story = {
  args: threadArgs(oneToolMessages, "Login"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ToolUseMany: Story = {
  args: threadArgs(manyToolMessages, "Billing"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ToolUseStreaming: Story = {
  args: threadArgs(streamingToolMessages, "Repo"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ReasoningAndTools: Story = {
  args: threadArgs(reasoningAndToolsMessages, "Ledger"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ReasoningAndToolsStreaming: Story = {
  args: threadArgs(streamingReasoningAndToolsMessages, "Ledger"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const SourceLinks: Story = {
  args: threadArgs(sourceLinkMessages, "Payments API"),
  parameters: {
    storyRoute: threadRoute,
  },
}

export const ReadOnly: Story = {
  args: {
    ...threadArgs(docsConversationDetail.messages),
    workspace: readOnlyWorkspace,
  },
  parameters: {
    storyRoute: {
      ...threadRoute,
      workspaceSlug: "handbook",
    } satisfies StoryRouteParams,
  },
}

export const Waiting: Story = {
  args: threadArgs(docsConversationDetail.messages),
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, async () => {
            await delay("infinite")
            return new HttpResponse(null, { status: 200 })
          }),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/continue the conversation/i),
      "What about auth?",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => canvas.getByRole("status", { name: /thinking/i }), {
      timeout: SEND_WAIT_MS,
    })
  },
}

export const Streaming: Story = {
  args: threadArgs(docsConversationDetail.messages),
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () =>
            conversationAguiSseResponse(
              conversationAguiTextEvents({
                threadId: "conv_1",
                messageId: "msg_sse",
                text: "SSE fallback token",
              }),
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/continue the conversation/i),
      "Stream this",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => canvas.getByText(/SSE fallback token/), {
      timeout: SEND_WAIT_MS,
    })
  },
}

export const ComposeSendError: Story = {
  args: {
    conversationId: "conv_pending",
    composing: true,
    title: "New conversation",
    initialMessages: [],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () =>
            HttpResponse.json(
              {
                error:
                  "opencode serve exited before becoming ready: sh: opencode: not found",
              },
              { status: 500 },
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/ask about this workspace/i),
      "What is in this Workspace?",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => canvas.getByRole("alert"), { timeout: SEND_WAIT_MS })
  },
}

export const SendError: Story = {
  args: threadArgs(docsConversationDetail.messages),
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () =>
            HttpResponse.json(
              { error: "The chat sandbox is gone." },
              { status: 500 },
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/continue the conversation/i),
      "Retry this?",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => canvas.getByRole("alert"), { timeout: SEND_WAIT_MS })
  },
}

export const ListInsertOnSend: Story = {
  args: {
    conversationId: "conv_compose",
    composing: true,
    title: "New conversation",
    initialMessages: [],
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () =>
            conversationAguiSseResponse(
              conversationAguiTextEvents({
                threadId: "conv_compose",
                messageId: "msg_nav",
                text: "Nav row should already exist",
              }),
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/ask about this workspace/i),
      "Create this conversation",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => canvas.getByText(/Nav row should already exist/), {
      timeout: SEND_WAIT_MS,
    })
  },
}

export const HomeDraftClearsAfterSend: Story = {
  decorators: [
    (Story) => {
      resetHomeDraftSends()
      return <Story />
    },
  ],
  args: {
    conversationId: "conv_home_draft",
    composing: true,
    title: "New conversation",
    initialMessages: [],
    draftSeed: "What changed this week?",
    autoSendDraft: true,
  },
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () =>
            conversationAguiSseResponse(
              conversationAguiTextEvents({
                threadId: "conv_home_draft",
                messageId: "msg_home_draft",
                text: "Here is this week's activity.",
              }),
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() => canvas.getByText(/What changed this week/), {
      timeout: SEND_WAIT_MS,
    })
    await waitFor(() => {
      const input = canvas.getByPlaceholderText(
        /ask about this workspace|continue the conversation/i,
      )
      expect(input).toHaveValue("")
    })
  },
}
