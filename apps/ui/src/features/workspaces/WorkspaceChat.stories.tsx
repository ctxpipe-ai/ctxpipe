import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
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
      await canvas.findByRole("heading", { name: "Conversation not found" }),
    ).toBeVisible()
    expect(
      canvas.queryByPlaceholderText(/ask about this workspace/i),
    ).toBeNull()
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
        page: [conversationDetailHandler(null), ...workspaceShellHandlers()],
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
    const sockets: WebSocket[] = []
    let closeCount = 0
    function TrackingWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols
        ? new Original(url, protocols)
        : new Original(url)
      sockets.push(socket)
      const nativeClose = socket.close.bind(socket)
      Object.defineProperty(socket, "close", {
        configurable: true,
        value(code?: number, reason?: string) {
          closeCount += 1
          return nativeClose(code, reason)
        },
      })
      return socket
    }
    TrackingWebSocket.prototype = Original.prototype
    Object.assign(TrackingWebSocket, {
      CONNECTING: Original.CONNECTING,
      OPEN: Original.OPEN,
      CLOSING: Original.CLOSING,
      CLOSED: Original.CLOSED,
    })
    window.WebSocket = TrackingWebSocket as unknown as typeof WebSocket
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
      const closesBeforeLeave = closeCount
      await userEvent.click(
        canvas.getByRole("button", { name: "Leave conversation" }),
      )
      await waitFor(() => {
        expect(canvas.getByText("Left conversation")).toBeVisible()
      })
      await waitFor(() => {
        expect(closeCount).toBeGreaterThan(closesBeforeLeave)
        expect(
          sockets.filter((socket) =>
            String(socket.url).includes("/conversations/"),
          ).length,
        ).toBeGreaterThan(0)
        expect(
          sockets
            .filter((socket) => String(socket.url).includes("/conversations/"))
            .every(
              (socket) =>
                socket.readyState === Original.CLOSING ||
                socket.readyState === Original.CLOSED,
            ),
        ).toBe(true)
      })
    } finally {
      window.WebSocket = Original
    }
  },
}

function ReloadReconnectHarness() {
  const [generation, setGeneration] = useState(0)
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex gap-2 p-2">
        <Button
          variant="secondary"
          onPress={() => setGeneration((current) => current + 1)}
        >
          Reload conversation
        </Button>
      </div>
      <WorkspaceChat
        key={generation}
        orgSlug="acme"
        workspace={docsWorkspace}
        conversationId="conv_1"
      />
    </div>
  )
}

export const ReloadReconnects: Story = {
  render: () => <ReloadReconnectHarness />,
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
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const Original = window.WebSocket
    let openCount = 0
    function TrackingWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols
        ? new Original(url, protocols)
        : new Original(url)
      if (String(socket.url).includes("/conversations/")) openCount += 1
      return socket
    }
    TrackingWebSocket.prototype = Original.prototype
    Object.assign(TrackingWebSocket, {
      CONNECTING: Original.CONNECTING,
      OPEN: Original.OPEN,
      CLOSING: Original.CLOSING,
      CLOSED: Original.CLOSED,
    })
    window.WebSocket = TrackingWebSocket as unknown as typeof WebSocket
    try {
      expect(
        await canvas.findByPlaceholderText(/continue the conversation/i),
      ).toBeVisible()
      await waitFor(() => {
        expect(openCount).toBeGreaterThan(0)
      })
      const openedBeforeReload = openCount
      await userEvent.click(
        canvas.getByRole("button", { name: "Reload conversation" }),
      )
      expect(
        await canvas.findByPlaceholderText(/continue the conversation/i),
      ).toBeVisible()
      expect(
        await canvas.findByText(/How is billing structured/i),
      ).toBeVisible()
      await waitFor(() => {
        expect(openCount).toBeGreaterThan(openedBeforeReload)
      })
      expect(canvas.getByText(/How is billing structured/i)).toBeVisible()
    } finally {
      window.WebSocket = Original
    }
  },
}

function RapidRouteHarness() {
  const [conversationId, setConversationId] = useState<string | undefined>(
    "conv_1",
  )
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-2 p-2">
        <Button variant="secondary" onPress={() => setConversationId("conv_1")}>
          Open ready
        </Button>
        <Button
          variant="secondary"
          onPress={() => setConversationId("conv_missing")}
        >
          Open missing
        </Button>
        <Button
          variant="secondary"
          onPress={() => setConversationId("conv_other")}
        >
          Open foreign
        </Button>
        <Button
          variant="secondary"
          onPress={() => setConversationId(undefined)}
        >
          Open compose
        </Button>
      </div>
      <WorkspaceChat
        orgSlug="acme"
        workspace={docsWorkspace}
        conversationId={conversationId}
      />
    </div>
  )
}

export const RapidRouteChanges: Story = {
  render: () => <RapidRouteHarness />,
  parameters: {
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            ({ request }) => {
              const id = new URL(request.url).pathname.split("/").pop()
              if (id === "conv_missing") {
                return HttpResponse.json(
                  { error: "not found" },
                  { status: 404 },
                )
              }
              if (id === "conv_other") {
                return HttpResponse.json({
                  ...docsConversationDetail,
                  conversation: {
                    ...docsConversationDetail.conversation,
                    id: "conv_other",
                    workspaceId: "ws_other",
                  },
                })
              }
              return HttpResponse.json(docsConversationDetail)
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("button", { name: "Open missing" }))
    await userEvent.click(canvas.getByRole("button", { name: "Open foreign" }))
    expect(
      await canvas.findByRole("heading", { name: "Conversation not found" }),
    ).toBeVisible()
    await userEvent.click(canvas.getByRole("button", { name: "Open missing" }))
    expect(
      await canvas.findByRole("heading", { name: "Conversation not found" }),
    ).toBeVisible()
    expect(
      canvas.queryByPlaceholderText(/ask about this workspace/i),
    ).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Open ready" }))
    expect(
      await canvas.findByPlaceholderText(/continue the conversation/i),
    ).toBeVisible()
    expect(
      canvas.queryByRole("heading", { name: "Conversation not found" }),
    ).toBeNull()
  },
}
