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
import { docsConversationDetail, docsWorkspace } from "./workspace-fixtures"
import { WorkspaceChat } from "./WorkspaceChat"

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
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Conversation not found" }),
      ).toBeVisible(),
    )
    expect(
      canvas.queryByPlaceholderText(
        /what should ctxpipe do in this workspace/i,
      ),
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
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Conversation not found" }),
      ).toBeVisible(),
    )
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

/** The header title becomes an input. Enter saves with PATCH, Escape cancels, and an empty name does nothing. */
export const RenameConversation: Story = {
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
        page: [
          http.patch(
            ({ request }) =>
              /\/api\/v1\/conversations\/conv_1$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as { name: string }
              return HttpResponse.json({
                ...docsConversationDetail.conversation,
                name: body.name,
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
    const open = async (name: string) =>
      userEvent.click(
        await canvas.findByRole("button", {
          name: `Rename conversation: ${name}`,
        }),
      )
    // Escape cancels and keeps the name.
    await open("Repo layout")
    let input = await canvas.findByRole("textbox", {
      name: "Conversation name",
    })
    await userEvent.clear(input)
    await userEvent.type(input, "Discarded{Escape}")
    // The composer is a textbox too, so name the rename field.
    await waitFor(() =>
      expect(
        canvas.queryByRole("textbox", { name: "Conversation name" }),
      ).not.toBeInTheDocument(),
    )
    // An empty name does nothing.
    await open("Repo layout")
    input = await canvas.findByRole("textbox", { name: "Conversation name" })
    await userEvent.clear(input)
    await userEvent.keyboard("{Enter}")
    await waitFor(() =>
      expect(
        canvas.queryByRole("textbox", { name: "Conversation name" }),
      ).not.toBeInTheDocument(),
    )
    expect(
      canvas.getByRole("button", { name: "Rename conversation: Repo layout" }),
    ).toBeInTheDocument()
    // Enter saves.
    await open("Repo layout")
    input = await canvas.findByRole("textbox", { name: "Conversation name" })
    await userEvent.clear(input)
    await userEvent.type(input, "Billing layout{Enter}")
    expect(
      await canvas.findByRole("button", {
        name: "Rename conversation: Billing layout",
      }),
    ).toBeInTheDocument()
    expect(canvas.queryByRole("dialog")).not.toBeInTheDocument()
  },
}

/** The turn-change reads of `RenameBeatsAutomaticTitle`. A turn end reads them. */
const renameStory = { turnReads: 0 }

/**
 * The user renames, then the turn streams the automatic title. The header
 * keeps the user's name and never shows the automatic title.
 */
export const RenameBeatsAutomaticTitle: Story = {
  args: { conversationId: "conv_1" },
  beforeEach: () => {
    renameStory.turnReads = 0
  },
  parameters: {
    storyRoute: RenameConversation.parameters?.storyRoute,
    msw: {
      handlers: {
        page: [
          http.patch(
            ({ request }) =>
              /\/api\/v1\/conversations\/conv_1$/.test(
                new URL(request.url).pathname,
              ),
            async ({ request }) => {
              const body = (await request.json()) as { name: string }
              return HttpResponse.json({
                ...docsConversationDetail.conversation,
                name: body.name,
              })
            },
          ),
          http.get(
            ({ request }) =>
              /\/api\/v1\/conversations\/conv_1\/turns$/.test(
                new URL(request.url).pathname,
              ),
            () => {
              renameStory.turnReads += 1
              return HttpResponse.json({ items: [], syncs: [] })
            },
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket((threadId, runId) => {
      const events = conversationAguiTextEvents({
        threadId,
        runId,
        messageId: "msg_rename",
        text: "The ledger package holds billing.",
      })
      return [
        ...events.slice(0, -1),
        {
          type: "CUSTOM",
          name: "rename-conversation",
          value: { name: "Automatic title" },
        },
        ...events.slice(-1),
      ]
    })
    let showedAutomaticTitle = false
    const observer = new MutationObserver(() => {
      if (canvasElement.textContent?.includes("Automatic title"))
        showedAutomaticTitle = true
    })
    observer.observe(canvasElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
    })
    try {
      await userEvent.click(
        await canvas.findByRole("button", {
          name: "Rename conversation: Repo layout",
        }),
      )
      const input = await canvas.findByRole("textbox", {
        name: "Conversation name",
      })
      await userEvent.clear(input)
      await userEvent.type(input, "Billing layout{Enter}")
      await canvas.findByRole("button", {
        name: "Rename conversation: Billing layout",
      })

      await userEvent.type(
        await canvas.findByPlaceholderText(/continue the conversation/i),
        "Where is billing?",
      )
      const readsBeforeSend = renameStory.turnReads
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await waitFor(
        () =>
          expect(
            canvas.getByText("The ledger package holds billing."),
          ).toBeVisible(),
        { timeout: SEND_WAIT_MS },
      )
      // The turn end reads the turn changes again. The rename chunk is before
      // the turn end, so the session has handled it now.
      await waitFor(
        () => expect(renameStory.turnReads).toBeGreaterThan(readsBeforeSend),
        { timeout: SEND_WAIT_MS },
      )
      expect(
        canvas.getByRole("button", {
          name: "Rename conversation: Billing layout",
        }),
      ).toBeInTheDocument()
      expect(showedAutomaticTitle).toBe(false)
    } finally {
      observer.disconnect()
      socket.restore()
    }
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
    intent:
      "Catches a conversation socket that stays open after the user leaves the conversation. Leaving must close every conversation socket. Not for messages.",
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
    intent:
      "Catches a reloaded conversation that does not open a new socket. A reload must reconnect and show the stored messages again. Not for streaming or sends.",
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
      await waitFor(() =>
        expect(
          canvas.getByPlaceholderText(/continue the conversation/i),
        ).toBeVisible(),
      )
      await waitFor(() => {
        expect(openCount).toBeGreaterThan(0)
      })
      const openedBeforeReload = openCount
      await userEvent.click(
        canvas.getByRole("button", { name: "Reload conversation" }),
      )
      await waitFor(() =>
        expect(
          canvas.getByPlaceholderText(/continue the conversation/i),
        ).toBeVisible(),
      )
      await waitFor(() =>
        expect(canvas.getByText(/How is billing structured/i)).toBeVisible(),
      )
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
    intent:
      "Catches fast switches between conversations that leave a stale error or composer. The last route wins: missing shows not found, ready shows the follow-up composer. Not for messages.",
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
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Conversation not found" }),
      ).toBeVisible(),
    )
    await userEvent.click(canvas.getByRole("button", { name: "Open missing" }))
    await waitFor(() =>
      expect(
        canvas.getByRole("heading", { name: "Conversation not found" }),
      ).toBeVisible(),
    )
    expect(
      canvas.queryByPlaceholderText(
        /what should ctxpipe do in this workspace/i,
      ),
    ).toBeNull()
    await userEvent.click(canvas.getByRole("button", { name: "Open ready" }))
    await waitFor(() =>
      expect(
        canvas.getByPlaceholderText(/continue the conversation/i),
      ).toBeVisible(),
    )
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
    intent:
      "Catches a late failed send that replaces a finished answer. The first answer stays visible and the error shows as an alert. Not for first turn streaming.",
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
        await canvas.findByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
        "What is in this Workspace?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await waitFor(
        () => expect(canvas.getByText(lateErrorFirstAnswer)).toBeVisible(),
        { timeout: SEND_WAIT_MS },
      )
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
    intent:
      "Catches a first chat turn that does not stream live. Sandbox setup, thinking, the tool call, and the answer show in order without a reload. Not for chat API shapes or auth.",
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
        await canvas.findByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
        "Where is the billing service?",
      )
      // Record the order in which each step of the turn first shows. The
      // status line shows the sandbox setup, then "Thinking", then the title
      // of the current thought.
      const shows = (text: string) =>
        canvasElement.textContent?.includes(text) ?? false
      const status = (text: string) => () =>
        canvasElement.querySelector(`[role="status"][aria-label="${text}"]`) !==
        null
      const steps: [string, () => boolean][] = [
        ["Setting up sandbox", status("Setting up sandbox")],
        ["Thinking", status("Thinking")],
        ["current thought", status("Finding billing")],
        ["Used 1 tool", () => shows("Used 1 tool")],
        ["answer", () => shows(firstTurnAnswer)],
      ]
      const seen: string[] = []
      const observer = new MutationObserver(() => {
        for (const [name, test] of steps)
          if (!seen.includes(name) && test()) seen.push(name)
      })
      observer.observe(canvasElement, {
        childList: true,
        subtree: true,
        characterData: true,
      })
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      try {
        await waitFor(
          () => expect(canvas.getByText(firstTurnAnswer)).toBeVisible(),
          { timeout: SEND_WAIT_MS },
        )
      } finally {
        observer.disconnect()
      }
      expect(seen).toEqual(steps.map(([name]) => name))
      expect(canvas.getByText("Used 1 tool")).toBeVisible()
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

/** Records each new status line label, in the order the user sees them. */
function recordStatusLabels(root: HTMLElement) {
  const labels: string[] = []
  const observer = new MutationObserver(() => {
    const label = root
      .querySelector('[role="status"][aria-label]')
      ?.getAttribute("aria-label")
    if (label && labels.at(-1) !== label) labels.push(label)
  })
  observer.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  })
  return { labels, stop: () => observer.disconnect() }
}

const followUpAnswer = "The ledger package has no Docker setup."

/** A follow-up turn: the backend sets up the sandbox again before it thinks. */
function followUpEvents(threadId: string, runId: string): object[] {
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "starting" } },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "ready" } },
    {
      type: "TEXT_MESSAGE_START",
      messageId: "msg_follow_up",
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg_follow_up",
      delta: followUpAnswer,
    },
    { type: "TEXT_MESSAGE_END", messageId: "msg_follow_up" },
    { type: "RUN_FINISHED", threadId, runId },
  ]
}

/**
 * A follow-up turn shows "Setting up sandbox" first and "Thinking" only
 * after the sandbox is ready. No other label shows before the setup label.
 */
export const FollowUpShowsSandboxSetupFirst: Story = {
  tags: ["workspace-golden"],
  render: () => <ComposeHarness />,
  parameters: {
    ...FirstTurnStreamsLive.parameters,
    intent:
      "Catches a follow-up turn that shows Thinking before the sandbox is ready. The status line shows Setting up sandbox first, with no other label before it. Not for the first turn.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket((threadId, runId, index) =>
      index === 0
        ? firstTurnEvents(threadId, runId)
        : followUpEvents(threadId, runId),
    )
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
        "Where is the billing service?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await canvas.findByText(firstTurnAnswer, undefined, {
        timeout: SEND_WAIT_MS,
      })
      await waitFor(
        () => {
          expect(canvas.queryAllByRole("status")).toHaveLength(0)
        },
        { timeout: SEND_WAIT_MS },
      )
      await userEvent.type(
        await canvas.findByPlaceholderText(/continue the conversation/i),
        "Does it use Docker?",
      )
      const status = recordStatusLabels(canvasElement)
      await userEvent.click(canvas.getByRole("button", { name: /^send$/i }))
      try {
        await waitFor(
          () => expect(canvas.getByText(followUpAnswer)).toBeVisible(),
          { timeout: SEND_WAIT_MS },
        )
      } finally {
        status.stop()
      }
      expect(status.labels).toEqual(["Setting up sandbox", "Thinking"])
    } finally {
      socket.restore()
    }
  },
}

/** A turn that thinks, uses a tool, thinks again, and uses a second tool. */
function interleavedTurnEvents(threadId: string, runId: string): object[] {
  const thought = (id: string, text: string) => [
    { type: "REASONING_START", messageId: id },
    { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
    { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: text },
    { type: "REASONING_MESSAGE_END", messageId: id },
    { type: "REASONING_END", messageId: id },
  ]
  const tool = (id: string, name: string, args: object) => [
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: name,
      parentMessageId: "msg_interleaved",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(args) },
    { type: "TOOL_CALL_END", toolCallId: id },
    {
      type: "TOOL_CALL_RESULT",
      messageId: `${id}_result`,
      toolCallId: id,
      content: "done",
      role: "tool",
    },
  ]
  return [
    { type: "RUN_STARTED", threadId, runId },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "starting" } },
    { type: "CUSTOM", name: "sandbox-setup", value: { phase: "ready" } },
    ...thought("reason_one", "**Reading the guide**\n\nOpen the Docker notes."),
    ...tool("call_read", "read", { filePath: "knowledge/docker.md" }),
    ...thought("reason_two", "**Checking the tree**\n\nLook for changes."),
    ...tool("call_bash", "bash", { command: "git status" }),
    {
      type: "TEXT_MESSAGE_START",
      messageId: "msg_interleaved",
      role: "assistant",
    },
    {
      type: "TEXT_MESSAGE_CONTENT",
      messageId: "msg_interleaved",
      delta: firstTurnAnswer,
    },
    { type: "TEXT_MESSAGE_END", messageId: "msg_interleaved" },
    { type: "RUN_FINISHED", threadId, runId },
  ]
}

/**
 * The log lists thoughts and tool calls in the order they happened, also
 * when a thought comes after a tool call. Each tool row shows its detail.
 */
export const LogKeepsStreamOrder: Story = {
  tags: ["workspace-golden"],
  render: () => <ComposeHarness />,
  parameters: {
    ...FirstTurnStreamsLive.parameters,
    intent:
      "Catches an activity log that reorders thoughts and tool calls. Rows follow the stream order, also when a thought comes after a tool call. Not for spacing or the closed log.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket(interleavedTurnEvents)
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
        "Where is the billing service?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await canvas.findByText(firstTurnAnswer, undefined, {
        timeout: SEND_WAIT_MS,
      })
      await userEvent.click(canvas.getByRole("button", { name: /2 thoughts/i }))
      const region = canvas.getByRole("region", { name: "Activity log" })
      const rows = within(region)
        .getAllByRole("listitem")
        .map((row) => row.textContent ?? "")
      expect(rows).toHaveLength(4)
      expect(rows[0]).toContain("Reading the guide")
      expect(rows[1]).toContain("Read file")
      expect(rows[1]).toContain("knowledge/docker.md")
      expect(rows[2]).toContain("Checking the tree")
      expect(rows[3]).toContain("Run command")
      expect(rows[3]).toContain("git status")
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
  parameters: {
    ...FirstTurnStreamsLive.parameters,
    intent:
      "Catches a failed first turn that loses the user's message. The error shows and the composer holds the message again to send. Not for successful turns.",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket((threadId, runId) => [
      { type: "RUN_STARTED", threadId, runId },
      { type: "RUN_ERROR", runId, message: capacityError },
    ])
    try {
      await userEvent.type(
        await canvas.findByPlaceholderText(
          /what should ctxpipe do in this workspace/i,
        ),
        "Where is the billing service?",
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await waitFor(
        () => expect(canvas.getByText(/at capacity/)).toBeVisible(),
        { timeout: SEND_WAIT_MS },
      )
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

/** The conversation ids of the prepare requests that the story saw. */
const preparedConversations: string[] = []

/**
 * Opening the new-conversation composer starts the sandbox prepare, before
 * the first message. The first message then uses the prepared conversation,
 * so the session does not prepare again and the turn does not wait for it.
 */
export const ComposeOpenPreparesSandbox: Story = {
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
          http.post(
            ({ request }) =>
              /\/api\/v1\/conversations\/[^/]+\/prepare$/.test(
                new URL(request.url).pathname,
              ),
            ({ request }) => {
              const id = new URL(request.url).pathname.split("/").at(-2)
              if (id) preparedConversations.push(id)
              return new HttpResponse(null, { status: 204 })
            },
          ),
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
    preparedConversations.length = 0
    const canvas = within(canvasElement)
    const socket = installAguiWebSocket(firstTurnEvents)
    try {
      const composer = await canvas.findByPlaceholderText(
        /what should ctxpipe do in this workspace/i,
      )
      await userEvent.click(composer)
      await waitFor(() =>
        expect(preparedConversations.length).toBeGreaterThan(0),
      )
      await userEvent.type(composer, "Where is the billing service?")
      // The story harness can mount the composer again with a new query
      // cache; count only what the send adds.
      const beforeSend = [...preparedConversations]
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await waitFor(
        () => expect(canvas.getByText(firstTurnAnswer)).toBeVisible(),
        { timeout: SEND_WAIT_MS },
      )
      expect(socket.runFrames).toHaveLength(1)
      const { threadId } = socket.runFrames[0] as { threadId: string }
      expect(beforeSend.at(-1), JSON.stringify(beforeSend)).toBe(threadId)
      expect(preparedConversations).toEqual(beforeSend)
    } finally {
      socket.restore()
    }
  },
}
