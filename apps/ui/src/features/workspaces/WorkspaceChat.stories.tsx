import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
import {
  conversationDetailHandler,
  conversationDetailLoadingHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceChat } from "./WorkspaceChat"
import { docsConversationDetail, docsWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/Chat",
  component: WorkspaceChat,
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
  },
  args: {
    orgSlug: "acme",
    workspace: docsWorkspace,
  },
} satisfies Meta<typeof WorkspaceChat>

export default meta

type Story = StoryObj<typeof meta>

export const ComposeEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

export const ConversationLoading: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [conversationDetailLoadingHandler(), ...workspaceShellHandlers()],
      },
    },
  },
}

export const ConversationMissing: Story = {
  args: { conversationId: "conv_missing" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_missing",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [conversationDetailHandler(null), ...workspaceShellHandlers()],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByPlaceholderText(/ask about this workspace/i),
    ).toBeVisible()
    expect(canvas.queryByText("Conversation not found")).toBeNull()
  },
}

export const ConversationForeignWorkspace: Story = {
  args: { conversationId: "conv_other" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_other",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          conversationDetailHandler({
            ...docsConversationDetail,
            conversation: {
              ...docsConversationDetail.conversation,
              id: "conv_other",
              workspaceId: "ws_other",
            },
          }),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    expect(
      await canvas.findByRole("heading", { name: "Conversation not found" }),
    ).toBeVisible()
  },
}

export const ConversationReady: Story = {
  args: { conversationId: "conv_1" },
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
      conversationId: "conv_1",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
}

function SocketCleanupHarness() {
  const [mounted, setMounted] = useState(false)
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex gap-2 p-2">
        <Button variant="secondary" onPress={() => setMounted(true)}>
          Open conversation
        </Button>
        <Button variant="secondary" onPress={() => setMounted(false)}>
          Leave conversation
        </Button>
      </div>
      {mounted ? (
        <WorkspaceChat orgSlug="acme" workspace={docsWorkspace} />
      ) : (
        <p>Left conversation</p>
      )}
    </div>
  )
}

export const SocketCleansUpOnLeave: Story = {
  render: () => <SocketCleanupHarness />,
  parameters: {
    msw: {
      handlers: {
        page: workspaceShellHandlers(),
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const Original = window.WebSocket
    const originalClose = Original.prototype.close
    const sockets: WebSocket[] = []
    const closeCounts = new WeakMap<WebSocket, number>()
    Original.prototype.close = function close(
      this: WebSocket,
      code?: number,
      reason?: string,
    ) {
      closeCounts.set(this, (closeCounts.get(this) ?? 0) + 1)
      return originalClose.call(this, code, reason)
    }
    window.WebSocket = class TrackingSocket extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols)
        sockets.push(this)
      }
    } as typeof WebSocket
    try {
      await userEvent.click(
        canvas.getByRole("button", { name: "Open conversation" }),
      )
      await waitFor(() => {
        expect(
          sockets.some((socket) =>
            String(socket.url).includes("/conversations/"),
          ),
        ).toBe(true)
      })
      const conversationSockets = sockets.filter((socket) =>
        String(socket.url).includes("/conversations/"),
      )
      await userEvent.click(
        canvas.getByRole("button", { name: "Leave conversation" }),
      )
      await waitFor(() => {
        expect(canvas.getByText("Left conversation")).toBeVisible()
      })
      await waitFor(() => {
        expect(conversationSockets.length).toBeGreaterThan(0)
        for (const socket of conversationSockets) {
          expect(closeCounts.get(socket) ?? 0).toBeGreaterThan(0)
        }
      })
    } finally {
      Original.prototype.close = originalClose
      window.WebSocket = Original
    }
  },
}
