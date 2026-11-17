import type { Meta, StoryObj } from "@storybook/react-vite"
import { HttpResponse, http } from "msw"
import { type ComponentProps, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"

import {
  conversationAguiTextEvents,
  installAguiWebSocket,
} from "@/mocks/conversation-agui"
import { signedInHandlers } from "@/mocks/handlers"
import {
  conversationChatHandler,
  workspaceShellHandlers,
} from "@/mocks/workspace-handlers"

import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
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
} from "./workspace-fixtures"
import { WorkspaceChatSession } from "./WorkspaceChatSession"

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
  // The last step of the spring scroll of the thread depends on the timing of
  // the frames, so the thread can stop 1 px lower on a slow host. Reduced
  // motion jumps to the bottom at once, so the screenshot is the same on each
  // host.
  tags: ["reduced-motion"],
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  parameters: {
    app: "root",
    review: { kind: "component" },
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspace",
      orgSlug: "acme",
      workspaceSlug: "docs",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        session: signedInHandlers,
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

/** The server has the same transcript as the thread that the page shows. */
function threadHandlers(messages: typeof docsConversationDetail.messages) {
  return {
    handlers: {
      page: [conversationChatHandler(messages), ...workspaceShellHandlers()],
    },
  }
}

/**
 * Chat session of a Workspace, where a member asks about the code: a member
 * opened a long thread, so it scrolls to the latest answer and the first turns
 * are above the view.
 */
export const ThreadLong: Story = {
  args: threadArgs(longThreadMessages, "Billing"),
  parameters: {
    msw: threadHandlers(longThreadMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has Markdown headings, lists, and links.
 */
export const MarkdownAnswer: Story = {
  args: threadArgs(markdownAnswerMessages, "Auth"),
  parameters: {
    msw: threadHandlers(markdownAnswerMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has a TypeScript code block with syntax colors.
 */
export const CodeAnswer: Story = {
  args: threadArgs(codeAnswerMessages, "Session helper"),
  parameters: {
    msw: threadHandlers(codeAnswerMessages),
    storyRoute: threadRoute,
  },
  play: async ({ canvasElement }) => {
    // The code block shows the code in one color first. Shiki colors each
    // token when it has loaded the TypeScript grammar, which is a lazy chunk.
    await waitFor(
      () => {
        const colors = new Set(
          Array.from(
            canvasElement.querySelectorAll<HTMLElement>(
              'pre [style*="--sdm-c"]',
            ),
            (token) => token.style.getPropertyValue("--sdm-c"),
          ),
        )
        expect(colors.size).toBeGreaterThan(1)
      },
      { timeout: 15_000 },
    )
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has a finished reasoning block before the text.
 */
export const Reasoning: Story = {
  args: threadArgs(reasoningMessages, "Ledger"),
  parameters: {
    msw: threadHandlers(reasoningMessages),
    storyRoute: threadRoute,
  },
}

/**
 * A follow-up turn that runs in the screenshot: the member sends `question`,
 * and the socket answers with `events` after the start of the run. The run
 * never finishes, so the thread shows the live turn and the Stop button.
 */
function liveTurn(
  question: string,
  events: object[],
  lastChunk: string,
): Pick<Story, "args" | "beforeEach" | "play"> {
  return {
    args: threadArgs(docsConversationDetail.messages, "Billing"),
    beforeEach: () =>
      installAguiWebSocket((threadId, runId) => [
        { type: "RUN_STARTED", threadId, runId },
        { type: "CUSTOM", name: "sandbox-setup", value: { phase: "starting" } },
        { type: "CUSTOM", name: "sandbox-setup", value: { phase: "ready" } },
        ...events,
      ]).restore,
    play: async ({ canvasElement }) => {
      const canvas = within(canvasElement)
      await userEvent.type(
        canvas.getByPlaceholderText(/continue the conversation/i),
        question,
      )
      await userEvent.click(canvas.getByRole("button", { name: /send/i }))
      await canvas.findByRole(
        "button",
        { name: "Stop" },
        {
          timeout: SEND_WAIT_MS,
        },
      )
      // The text of the last chunk shows when the socket sent all of them.
      await canvas.findByText(lastChunk, undefined, { timeout: SEND_WAIT_MS })
    },
  }
}

const liveTurnParameters = {
  storyRoute: threadRoute,
  msw: { handlers: { page: [...workspaceShellHandlers()] } },
}

/** A thought as the backend streams it; an open thought has no end yet. */
function thoughtEvents(id: string, text: string, open = false): object[] {
  return [
    { type: "REASONING_START", messageId: id },
    { type: "REASONING_MESSAGE_START", messageId: id, role: "reasoning" },
    { type: "REASONING_MESSAGE_CONTENT", messageId: id, delta: text },
    ...(open
      ? []
      : [
          { type: "REASONING_MESSAGE_END", messageId: id },
          { type: "REASONING_END", messageId: id },
        ]),
  ]
}

/** A tool call as the backend streams it; a running call has no result yet. */
function toolEvents(
  id: string,
  name: string,
  input: object,
  running = false,
): object[] {
  return [
    {
      type: "TOOL_CALL_START",
      toolCallId: id,
      toolCallName: name,
      parentMessageId: "msg_live",
    },
    { type: "TOOL_CALL_ARGS", toolCallId: id, delta: JSON.stringify(input) },
    { type: "TOOL_CALL_END", toolCallId: id },
    ...(running
      ? []
      : [
          {
            type: "TOOL_CALL_RESULT",
            messageId: `${id}_result`,
            toolCallId: id,
            content: "done",
            role: "tool",
          },
        ]),
  ]
}

const refundsThought =
  "**Finding the refund rules**\n\nThe ledger file names a refunds page. I should read it before I answer."

/**
 * Chat session of a Workspace, where a member asks about the code: the agent
 * still writes its first thought, so the status line names the thought and Stop
 * shows.
 */
export const ReasoningStreaming: Story = {
  ...liveTurn(
    "Who can approve a refund?",
    [...thoughtEvents("reason_live", refundsThought, true)],
    "Finding the refund rules",
  ),
  parameters: {
    ...liveTurnParameters,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has one finished tool call.
 */
export const ToolUse: Story = {
  args: threadArgs(oneToolMessages, "Login"),
  parameters: {
    msw: threadHandlers(oneToolMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has many finished tool calls.
 */
export const ToolUseMany: Story = {
  args: threadArgs(manyToolMessages, "Billing"),
  parameters: {
    msw: threadHandlers(manyToolMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the agent
 * searched and still reads a file, so the log counts both tools and Stop shows.
 */
export const ToolUseStreaming: Story = {
  ...liveTurn(
    "Which file holds the refund rules?",
    [
      ...toolEvents("tc_live_search", "hybrid_search", {
        query: "refund rules",
      }),
      ...toolEvents(
        "tc_live_read",
        "get_file",
        { filePath: "knowledge/payments/refunds.md" },
        true,
      ),
    ],
    "Read 1 file",
  ),
  parameters: {
    ...liveTurnParameters,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * has reasoning and tool calls, all finished.
 */
export const ReasoningAndTools: Story = {
  args: threadArgs(reasoningAndToolsMessages, "Ledger"),
  parameters: {
    msw: threadHandlers(reasoningAndToolsMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the agent
 * thought, searched, and still reads a file, so the log counts each step and
 * Stop shows.
 */
export const ReasoningAndToolsStreaming: Story = {
  ...liveTurn(
    "Why ledger.md and not invoices.md?",
    [
      ...thoughtEvents(
        "reason_live",
        "**Comparing the files**\n\nInvoice documents come from the ledger. I should check the billing docs.",
      ),
      ...toolEvents("tc_live_search", "hybrid_search", {
        query: "ledger vs invoices",
      }),
      ...toolEvents(
        "tc_live_read",
        "get_file",
        { filePath: "knowledge/billing/ledger.md" },
        true,
      ),
    ],
    "Read 1 file",
  ),
  parameters: {
    ...liveTurnParameters,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the answer
 * links to source files.
 */
export const SourceLinks: Story = {
  args: threadArgs(sourceLinkMessages, "Payments API"),
  parameters: {
    msw: threadHandlers(sourceLinkMessages),
    storyRoute: threadRoute,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the
 * Workspace is read-only, so the member cannot send a message.
 */
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

/**
 * Chat session of a Workspace, where a member asks about the code: the member
 * sent a question and the sandbox is still in setup.
 */
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

/**
 * Chat session of a Workspace, where a member asks about the code: the member
 * sent a follow-up question, and the first words of the answer stream in while
 * Stop shows.
 */
export const Streaming: Story = {
  ...liveTurn(
    "Where do refunds go?",
    [
      { type: "TEXT_MESSAGE_START", messageId: "msg_live", role: "assistant" },
      {
        type: "TEXT_MESSAGE_CONTENT",
        messageId: "msg_live",
        delta: "Refunds go through the payments API and reverse the",
      },
    ],
    "Refunds go through the payments API and reverse the",
  ),
  parameters: {
    ...liveTurnParameters,
  },
}

/**
 * Chat session of a Workspace, where a member asks about the code: the
 * organization is at its chat limit, so an alert tells the member to try again
 * later.
 */
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

/**
 * Chat session of a Workspace, where a member asks about the code: the run
 * failed after a send, and an alert shows the error.
 */
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
    review: {
      purpose:
        "Chat session of a Workspace, where a member asks about the code: the turn stopped before an answer, the member pressed Retry, and the answer arrived.",
    },
    storyRoute: threadRoute,
    msw: {
      handlers: {
        page: [
          conversationChatHandler([stoppedQuestion]),
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
  parameters: {
    ...runningTurn.parameters,
    review: {
      purpose:
        "Chat session of a Workspace, where a member asks about the code: the member left during a turn, so the chat closed and the turn continues.",
    },
  },
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
  parameters: {
    ...runningTurn.parameters,
    review: {
      purpose:
        "Chat session of a Workspace, where a member asks about the code: the member clicked Stop during a running turn.",
    },
  },
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
