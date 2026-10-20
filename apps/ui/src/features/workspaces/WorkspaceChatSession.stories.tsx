import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  conversationAguiTextEvents,
  installAguiWebSocket,
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
    title,
    initialMessages: messages,
  }
}

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
  // The socket takes the run and answers nothing.
  beforeEach: () => installAguiWebSocket(() => []).restore,
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [...workspaceShellHandlers()],
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
    await waitFor(
      () => canvas.getByRole("status", { name: "Setting up sandbox" }),
      {
        timeout: SEND_WAIT_MS,
      },
    )
  },
}

export const Streaming: Story = {
  args: threadArgs(docsConversationDetail.messages),
  beforeEach: () =>
    installAguiWebSocket((threadId, runId) =>
      conversationAguiTextEvents({
        threadId,
        runId,
        messageId: "msg_socket",
        text: "Socket token",
      }),
    ).restore,
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [...workspaceShellHandlers()],
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
    await waitFor(() => canvas.getByText(/Socket token/), {
      timeout: SEND_WAIT_MS,
    })
  },
}

export const PrepareAtCapacity: Story = {
  args: threadArgs(docsConversationDetail.messages),
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          http.post(/\/api\/v1\/conversations\/[^/]+\/prepare$/, () =>
            HttpResponse.json(
              {
                error:
                  "Workspace chat is at capacity: your organization already has 50 chats running. Try again in a few minutes, after an idle chat stops.",
              },
              { status: 429 },
            ),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const alert = await waitFor(() => canvas.getByRole("alert"), {
      timeout: SEND_WAIT_MS,
    })
    await waitFor(() => {
      if (!/at capacity/.test(alert.textContent ?? ""))
        throw new Error("The at-capacity message is not shown")
    })
  },
}

export const SendError: Story = {
  args: threadArgs(docsConversationDetail.messages),
  beforeEach: () =>
    installAguiWebSocket((threadId, runId) => [
      { type: "RUN_STARTED", threadId, runId },
      { type: "RUN_ERROR", runId, message: "The chat sandbox is gone." },
    ]).restore,
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [...workspaceShellHandlers()],
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

const stoppedQuestion = {
  id: "msg_user_stopped",
  role: "user" as const,
  parts: [
    { type: "text" as const, content: "Why did hydrate skip ledger.md?" },
  ],
  createdAt: new Date("2026-08-16T09:30:00.000Z"),
}

/** The socket of the story that retries a stopped turn. */
let retrySocket: ReturnType<typeof installAguiWebSocket> | undefined

/**
 * The turn stopped before the first model round: the transcript holds only
 * the question, and no run is active. The thread shows the question and that
 * the turn stopped. Retry sends the question again.
 */
export const StoppedBeforeFirstAnswer: Story = {
  args: threadArgs([stoppedQuestion], "Skipped file"),
  beforeEach: () => {
    retrySocket = installAguiWebSocket((threadId, runId) =>
      conversationAguiTextEvents({
        threadId,
        runId,
        messageId: "msg_retry_answer",
        text: "Hydrate skipped ledger.md because it is larger than the limit.",
      }),
    )
    return retrySocket.restore
  },
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          http.get(/\/api\/v1\/conversations\/conv_1\/chat$/, () =>
            HttpResponse.json({
              messages: [stoppedQuestion],
              activeRun: null,
              interrupts: null,
            }),
          ),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await waitFor(() =>
      expect(canvas.getByText("Why did hydrate skip ledger.md?")).toBeVisible(),
    )
    const stopped = await waitFor(
      () => {
        const alert = canvas
          .getByText("The agent stopped before it answered")
          .closest<HTMLElement>('[role="alert"]')
        expect(alert).toBeVisible()
        return alert as HTMLElement
      },
      { timeout: SEND_WAIT_MS },
    )

    await userEvent.click(
      within(stopped).getByRole("button", { name: "Retry" }),
    )

    await canvas.findByText(/larger than the limit/, undefined, {
      timeout: SEND_WAIT_MS,
    })
    await expect(
      canvas.queryByText("The agent stopped before it answered"),
    ).toBeNull()
    const frame = retrySocket?.runFrames.at(-1) as {
      messages?: Array<{ id?: string }>
    }
    await expect(frame?.messages?.map((message) => message.id)).toEqual([
      "msg_user_stopped",
    ])
  },
}

/** The socket of the stories that leave or stop a running turn. */
let turnSocket: ReturnType<typeof installAguiWebSocket> | undefined

function abortFrames() {
  return (turnSocket?.runFrames ?? []).filter(
    (frame) => (frame as { type?: string }).type === "abort",
  )
}

/** The chat with a control that leaves it, as a move to another page does. */
function LeavableChatSession(
  props: ComponentProps<typeof WorkspaceChatSession>,
) {
  const [open, setOpen] = useState(true)
  return (
    <div className="flex flex-1 flex-col">
      <button type="button" onClick={() => setOpen(false)}>
        Leave conversation
      </button>
      {open ? <WorkspaceChatSession {...props} /> : null}
    </div>
  )
}

const runningTurn: Story = {
  args: threadArgs(docsConversationDetail.messages),
  render: (args) => <LeavableChatSession {...args} />,
  // The turn starts and does not end. An abort frame gets no answer.
  beforeEach: () => {
    turnSocket = installAguiWebSocket((threadId, runId) =>
      threadId ? [{ type: "RUN_STARTED", threadId, runId }] : [],
    )
    return turnSocket.restore
  },
  parameters: {
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [...workspaceShellHandlers()],
      },
    },
  },
}

async function startTurn(canvasElement: HTMLElement) {
  const canvas = within(canvasElement)
  await userEvent.type(
    canvas.getByPlaceholderText(/continue the conversation/i),
    "Run the long check",
  )
  await userEvent.click(canvas.getByRole("button", { name: /send/i }))
  await waitFor(() => expect(turnSocket?.runFrames).toHaveLength(1), {
    timeout: SEND_WAIT_MS,
  })
  return canvas.findByRole(
    "button",
    { name: "Stop" },
    { timeout: SEND_WAIT_MS },
  )
}

/**
 * The user leaves the conversation during a turn. The chat closes its socket
 * and sends no abort frame, so the turn continues on the server.
 */
export const LeaveDuringTurn: Story = {
  ...runningTurn,
  play: async ({ canvasElement }) => {
    await startTurn(canvasElement)
    const canvas = within(canvasElement)

    await userEvent.click(
      canvas.getByRole("button", { name: "Leave conversation" }),
    )

    await waitFor(() =>
      expect(
        canvas.queryByPlaceholderText(/continue the conversation/i),
      ).toBeNull(),
    )
    // The chat client stops its turn on a later timer.
    await new Promise((resolve) => setTimeout(resolve, 100))
    await expect(abortFrames()).toEqual([])
  },
}

/** Stop during a turn sends the abort frame of the turn. */
export const StopDuringTurn: Story = {
  ...runningTurn,
  play: async ({ canvasElement }) => {
    const stop = await startTurn(canvasElement)
    const runId = (turnSocket?.runFrames[0] as { runId?: string }).runId

    await userEvent.click(stop)

    await waitFor(() =>
      expect(abortFrames()).toContainEqual({ type: "abort", runId }),
    )
  },
}
