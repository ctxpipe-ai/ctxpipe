import type { Meta, StoryObj } from "@storybook/react-vite"
import { useNavigate, useParams } from "@tanstack/react-router"
import { HttpResponse, http } from "msw"
import { StrictMode, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { Button } from "@/components/ui/Button"
import {
  conversationAguiTextEvents,
  installAguiWebSocket,
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
        await canvas.findByRole("button", { name: "Open conversation" }),
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
    await userEvent.click(
      await canvas.findByRole("button", { name: "Open missing" }),
    )
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

function ComposeHarness() {
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
  render: () => <ComposeHarness />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
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
              return HttpResponse.json({
                ...lateErrorDetail,
                conversation: {
                  ...lateErrorDetail.conversation,
                  id,
                },
              })
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket((threadId, runId, index) =>
      index === 0
        ? conversationAguiTextEvents({
            threadId,
            runId,
            messageId: "msg_first",
            text: lateErrorFirstAnswer,
          })
        : [
            { type: "RUN_STARTED", threadId, runId },
            { type: "RUN_ERROR", runId, message: "late failure" },
          ],
    )
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(/ask about this workspace/i),
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
      await waitFor(
        () => {
          expect(canvas.getByRole("button", { name: /^send$/i })).toBeEnabled()
        },
        { timeout: SEND_WAIT_MS },
      )
      await userEvent.type(followUp, "This send should fail")
      await userEvent.click(canvas.getByRole("button", { name: /^send$/i }))
      await waitFor(() => canvas.getByRole("alert"), { timeout: SEND_WAIT_MS })
      expect(canvas.getByText(lateErrorFirstAnswer)).toBeVisible()
    } finally {
      socket.restore()
    }
  },
}

const firstTurnAnswer = "The billing service lives in the ledger package."

/** A first turn as the backend streams it: setup, reasoning, a tool, text. */
function firstTurnEvents(threadId: string, runId: string): object[] {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "starting" } },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "ready" } },
    { type: "REASONING_START", messageId: "reason_first" },
    {
      type: "REASONING_MESSAGE_START",
      messageId: "reason_first",
      role: "reasoning",
    },
    {
      type: "REASONING_MESSAGE_CONTENT",
      messageId: "reason_first",
      delta: "**Finding billing**\n\nLooking for the billing service.",
    },
    { type: "REASONING_MESSAGE_END", messageId: "reason_first" },
    { type: "REASONING_END", messageId: "reason_first" },
    {
      type: "TOOL_CALL_START",
      toolCallId: "call_first",
      toolCallName: "bash",
      parentMessageId: "msg_first_turn",
    },
    {
      type: "TOOL_CALL_ARGS",
      toolCallId: "call_first",
      delta: '{"command":"ls packages"}',
    },
    { type: "TOOL_CALL_END", toolCallId: "call_first" },
    {
      type: "TOOL_CALL_RESULT",
      messageId: "tool_result_first",
      toolCallId: "call_first",
      content: "ledger",
      role: "tool",
    },
    {
      type: "TEXT_MESSAGE_START",
      messageId: "msg_first_turn",
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg_first_turn",
      delta: firstTurnAnswer,
    },
    { type: "TEXT_MESSAGE_END", messageId: "msg_first_turn" },
    { type: "RUN_FINISHED", threadId, runId },
  ]
}

/**
 * The first turn of a new conversation streams live: the sandbox setup, the
 * reasoning, the tool call, and the answer show without a reload. The stored
 * transcript stays empty while the turn runs, as on a real backend, so only
 * the live stream can show the answer.
 */
export const FirstTurnStreamsLive: Story = {
  tags: ["workspace-golden"],
  decorators: [
    (Story) => (
      <StrictMode>
        <Story />
      </StrictMode>
    ),
  ],
  render: () => <ComposeHarness />,
  parameters: {
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+(?:\/chat)?$/.test(
                new URL(request.url).pathname,
              ),
            () => HttpResponse.json({ error: "Not found" }, { status: 404 }),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket(firstTurnEvents)
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(/ask about this workspace/i),
        "Where is the billing service?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      // The user's sequence: the sandbox setup shows first, then the
      // reasoning, the tool call, and the answer stream in that order.
      expect(
        await canvas.findByRole("status", { name: /setting up sandbox/i }),
      ).toBeVisible()
      const answer = await canvas.findByText(firstTurnAnswer, undefined, {
        timeout: SEND_WAIT_MS,
      })
      const reasoning = canvas.getByText(/Looking for the billing service/)
      const tool = canvas.getByText("Used 1 tool")
      const follows = (first: Element, second: Element) =>
        Boolean(
          first.compareDocumentPosition(second) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        )
      expect(follows(reasoning, tool)).toBe(true)
      expect(follows(tool, answer)).toBe(true)
      expect(answer).toBeVisible()
      expect(tool).toBeVisible()
      expect(
        canvas.getAllByText(/Where is the billing service\?/),
      ).toHaveLength(1)
      expect(socket.runFrames).toHaveLength(1)
      await waitFor(() => {
        expect(
          canvas.queryByRole("status", { name: /setting up sandbox/i }),
        ).toBeNull()
      })
    } finally {
      socket.restore()
    }
  },
}

const capacityError =
  "Workspace chat is at capacity: your organization already has 50 chats running."

/**
 * When the first turn fails, the message goes back into the composer, so the
 * user can send it again without typing it.
 */
export const FirstTurnFailureRestoresDraft: Story = {
  tags: ["workspace-golden"],
  render: () => <ComposeHarness />,
  parameters: FirstTurnStreamsLive.parameters,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket((threadId, runId) => [
      { type: "RUN_STARTED", threadId, runId },
      { type: "RUN_ERROR", runId, message: capacityError },
    ])
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(/ask about this workspace/i),
        "Where is the billing service?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      expect(
        await canvas.findByText(/at capacity/, undefined, {
          timeout: SEND_WAIT_MS,
        }),
      ).toBeVisible()
      const composer = await canvas.findByPlaceholderText(
        /continue the conversation/i,
      )
      await waitFor(() => {
        expect(composer).toHaveValue("Where is the billing service?")
      })
    } finally {
      socket.restore()
    }
  },
}
