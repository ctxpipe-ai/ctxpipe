import type { Meta, StoryObj } from "@storybook/react-vite"
import { useNavigate, useParams } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
import {
  conversationAguiSseResponse,
  conversationAguiTextEvents,
  conversationPostPath,
} from "@/mocks/conversation-agui"
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
        <WorkspaceChat
          orgSlug="acme"
          workspace={docsWorkspace}
          conversationId="conv_1"
        />
      ) : (
        <p>Left conversation</p>
      )}
    </div>
  )
}

export const SocketCleansUpOnLeave: Story = {
  tags: ["workspace-golden"],
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
    function TrackingWebSocket(
      url: string | URL,
      protocols?: string | string[],
    ) {
      const socket = protocols
        ? new Original(url, protocols)
        : new Original(url)
      sockets.push(socket)
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
    const conversationSockets = () =>
      sockets.filter((socket) => String(socket.url).includes("/conversations/"))
    const expectConversationSocketsClosed = async () => {
      await waitFor(() => {
        expect(conversationSockets().length).toBeGreaterThan(0)
        expect(
          conversationSockets().every(
            (socket) =>
              socket.readyState === Original.CLOSING ||
              socket.readyState === Original.CLOSED,
          ),
        ).toBe(true)
      })
    }
    try {
      await userEvent.click(
        canvas.getByRole("button", { name: "Open conversation" }),
      )
      await waitFor(() => {
        expect(conversationSockets().length).toBeGreaterThan(0)
      })
      await userEvent.click(
        canvas.getByRole("button", { name: "Leave conversation" }),
      )
      await waitFor(() => {
        expect(canvas.getByText("Left conversation")).toBeVisible()
      })
      await expectConversationSocketsClosed()
      const socketsAfterFirstLeave = conversationSockets().length
      await userEvent.click(
        canvas.getByRole("button", { name: "Open conversation" }),
      )
      await waitFor(() => {
        expect(conversationSockets().length).toBeGreaterThan(
          socketsAfterFirstLeave,
        )
      })
      await userEvent.click(
        canvas.getByRole("button", { name: "Leave conversation" }),
      )
      await waitFor(() => {
        expect(canvas.getByText("Left conversation")).toBeVisible()
      })
      await expectConversationSocketsClosed()
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
  tags: ["workspace-golden"],
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
  const navigate = useNavigate()
  const params = useParams({ strict: false })
  const conversationId =
    typeof params.conversationId === "string"
      ? params.conversationId
      : undefined
  const openConversation = (id: string | undefined) => {
    if (id) {
      void navigate({
        to: "/$orgSlug/ws/$workspaceSlug/$conversationId",
        params: {
          orgSlug: "acme",
          workspaceSlug: "docs",
          conversationId: id,
        },
        search: (prev) => prev,
      })
      return
    }
    void navigate({
      to: "/$orgSlug/ws/$workspaceSlug",
      params: { orgSlug: "acme", workspaceSlug: "docs" },
      search: (prev) => prev,
    })
  }
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap gap-2 p-2">
        <Button variant="secondary" onPress={() => openConversation("conv_1")}>
          Open ready
        </Button>
        <Button
          variant="secondary"
          onPress={() => openConversation("conv_missing")}
        >
          Open missing
        </Button>
        <Button
          variant="secondary"
          onPress={() => openConversation("conv_other")}
        >
          Open foreign
        </Button>
        <Button variant="secondary" onPress={() => openConversation(undefined)}>
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
  tags: ["workspace-golden"],
  render: () => <RapidRouteHarness />,
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

const SEND_WAIT_MS = 8_000
const lateErrorConversationId = "conv_late"
const lateErrorFirstAnswer = "First answer should remain"

const lateErrorDetail = {
  ...docsConversationDetail,
  conversation: {
    ...docsConversationDetail.conversation,
    id: lateErrorConversationId,
    name: "New conversation",
  },
  messages: [
    {
      id: "msg_user_late",
      role: "user" as const,
      parts: [{ type: "text" as const, content: "What is in this Workspace?" }],
    },
    {
      id: "msg_assistant_late",
      role: "assistant" as const,
      parts: [{ type: "text" as const, content: lateErrorFirstAnswer }],
    },
  ],
}

function LateErrorComposeHarness() {
  const params = useParams({ strict: false })
  const conversationId =
    typeof params.conversationId === "string"
      ? params.conversationId
      : undefined
  return (
    <WorkspaceChat
      orgSlug="acme"
      workspace={docsWorkspace}
      conversationId={conversationId}
    />
  )
}

export const LateErrorDoesNotClobberSuccess: Story = {
  tags: ["workspace-golden"],
  render: () => <LateErrorComposeHarness />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, ({ request }) => {
            const path = new URL(request.url).pathname
            if (/\/api\/v1\/conversations\/?$/.test(path)) {
              return conversationAguiSseResponse(
                conversationAguiTextEvents({
                  threadId: lateErrorConversationId,
                  messageId: "msg_first",
                  text: lateErrorFirstAnswer,
                }),
              )
            }
            return HttpResponse.json({ error: "late failure" }, { status: 500 })
          }),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/chat$/.test(
                new URL(request.url).pathname,
              ),
            () =>
              HttpResponse.json({
                messages: lateErrorDetail.messages,
                activeRun: null,
                interrupts: null,
              }),
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+$/.test(
                new URL(request.url).pathname,
              ),
            ({ request }) => {
              const id = new URL(request.url).pathname.split("/").pop()
              if (id !== lateErrorConversationId) {
                return HttpResponse.json(
                  { error: "not found" },
                  { status: 404 },
                )
              }
              return HttpResponse.json(lateErrorDetail)
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const Original = window.WebSocket
    let failNextRun = false
    function ScriptedWebSocket(url: string | URL) {
      const socket: {
        url: string
        readyState: number
        bufferedAmount: number
        extensions: string
        protocol: string
        binaryType: BinaryType
        onopen: ((event: Event) => void) | null
        onerror: ((event: Event) => void) | null
        onclose: ((event: CloseEvent) => void) | null
        onmessage: ((event: MessageEvent<string>) => void) | null
        close: () => void
        send: () => void
        addEventListener: () => void
        removeEventListener: () => void
        dispatchEvent: () => boolean
      } = {
        url: String(url),
        readyState: Original.CONNECTING,
        bufferedAmount: 0,
        extensions: "",
        protocol: "",
        binaryType: "blob" as BinaryType,
        onopen: null,
        onerror: null,
        onclose: null,
        onmessage: null,
        close() {
          this.readyState = Original.CLOSED
          this.onclose?.(new CloseEvent("close"))
        },
        send() {
          if (!failNextRun) return
          queueMicrotask(() => {
            this.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "RUN_ERROR",
                  message: "late failure",
                }),
              }),
            )
          })
        },
        addEventListener() {},
        removeEventListener() {},
        dispatchEvent() {
          return true
        },
      }
      queueMicrotask(() => {
        socket.readyState = Original.OPEN
        socket.onopen?.(new Event("open"))
      })
      return socket
    }
    ScriptedWebSocket.prototype = Original.prototype
    Object.assign(ScriptedWebSocket, {
      CONNECTING: Original.CONNECTING,
      OPEN: Original.OPEN,
      CLOSING: Original.CLOSING,
      CLOSED: Original.CLOSED,
    })
    window.WebSocket = ScriptedWebSocket as unknown as typeof WebSocket
    try {
      await userEvent.type(
        canvas.getByPlaceholderText(/ask about this workspace/i),
        "What is in this Workspace?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      expect(
        await canvas.findByText(lateErrorFirstAnswer, undefined, {
          timeout: SEND_WAIT_MS,
        }),
      ).toBeVisible()
      const followUp = await canvas.findByPlaceholderText(
        /continue the conversation/i,
        undefined,
        { timeout: SEND_WAIT_MS },
      )
      failNextRun = true
      await userEvent.type(followUp, "This send should fail")
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await waitFor(() => canvas.getByRole("alert"), { timeout: SEND_WAIT_MS })
      expect(canvas.getByText(lateErrorFirstAnswer)).toBeVisible()
    } finally {
      window.WebSocket = Original
    }
  },
}
