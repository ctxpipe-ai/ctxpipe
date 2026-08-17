import type { Meta, StoryObj } from "@storybook/react-vite"
import { delay, HttpResponse, http } from "msw"
import { userEvent, waitFor, within } from "storybook/test"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChatSession } from "./WorkspaceChatSession"
import { docsConversationDetail, docsWorkspace } from "./workspace-fixtures"

const conversationPostPath = ({ request }: { request: Request }) =>
  /\/api\/v1\/conversations\/[^/]+$/.test(new URL(request.url).pathname)

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

export const ComposeEmpty: Story = {}

export const ThreadWithMessages: Story = {
  args: {
    conversationId: "conv_1",
    composing: false,
    title: docsConversationDetail.conversation.name,
    initialMessages: docsConversationDetail.messages,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
  },
}

export const Streaming: Story = {
  args: {
    conversationId: "conv_1",
    composing: false,
    title: docsConversationDetail.conversation.name,
    initialMessages: docsConversationDetail.messages,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
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
    await waitFor(() =>
      canvas.getByRole("status", { name: /waiting for response/i }),
    )
  },
}

export const SendError: Story = {
  args: {
    conversationId: "conv_1",
    composing: false,
    title: docsConversationDetail.conversation.name,
    initialMessages: docsConversationDetail.messages,
  },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
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
    await waitFor(() =>
      canvas.getByText(/chat request failed|sandbox is gone|failed/i),
    )
  },
}
