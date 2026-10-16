import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, fn, userEvent, waitFor, within } from "storybook/test"
import type { ChatMessage } from "@/features/chat/types"
import { ConversationSyncEntry } from "@/features/workspaces/ConversationSyncEntry"
import { ConversationTurnChangesCard } from "@/features/workspaces/ConversationTurnChangesCard"
import {
  docsConversationDetail,
  hydratedReasoningAndToolsMessages,
  manyToolMessages,
  oneToolMessages,
  progressDoneMessages,
  progressWorkingMessages,
  reasoningAndToolsMessages,
  reasoningMessages,
  streamingToolMessages,
  thoughtsBetweenToolsMessages,
} from "@/features/workspaces/workspace-fixtures"
import { ConversationThread } from "./ConversationThread"

const meta = {
  title: "Components/Chat/ConversationThread",
  component: ConversationThread,
  decorators: [
    (Story) => (
      <div className="flex h-[32rem] bg-zinc-950">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: "fullscreen",
  },
  args: {
    messages: docsConversationDetail.messages,
    error: null,
    status: "ready",
  },
} satisfies Meta<typeof ConversationThread>

export default meta

type Story = StoryObj<typeof meta>

const askOnly: ChatMessage[] = [
  {
    id: "msg_wait_u1",
    role: "user",
    parts: [{ type: "text", content: "What's in this Workspace?" }],
  },
]

const progressCounters = "Read 1 file, 2 searches, Used 1 tool, 3 thoughts"

/** Words of the old rotating labels; none of them is a real system state. */
const inventedLabel =
  /Contextualizing|Analyzing|Traversing|Reading knowledge|Checking sources/

export const ReplyOnly: Story = {}

/** While the agent works, the counters show and one line names the current thought. */
export const WorkingWithThought: Story = {
  args: {
    messages: progressWorkingMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    await expect(log).toHaveAttribute("aria-expanded", "false")
    await expect(log).toHaveTextContent("3 thoughts")
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(1)
    await expect(statuses[0]).toHaveTextContent("Checking the git status")
    // Only the title of the current thought shows, not its text.
    await expect(
      canvas.queryByText(/check the status before the commit/),
    ).toBeNull()
    await expect(canvas.queryByText("Inspecting knowledge units")).toBeNull()
    await expect(canvasElement).not.toHaveTextContent(inventedLabel)
  },
}

/** Before any activity, the line shows the real sandbox state. */
export const SettingUpSandbox: Story = {
  args: {
    messages: askOnly,
    status: "submitted",
    waitLabel: "Setting up sandbox",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(1)
    await expect(statuses[0]).toHaveTextContent("Setting up sandbox")
    await expect(canvasElement).not.toHaveTextContent(/Thinking/)
    await expect(canvasElement).not.toHaveTextContent(inventedLabel)
  },
}

/** With no thought and no system state, the line shows "Thinking". */
export const ThinkingFallback: Story = {
  args: {
    messages: askOnly,
    status: "submitted",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("status", { name: "Thinking" }),
    ).toHaveTextContent("Thinking")
    await expect(canvasElement).not.toHaveTextContent(inventedLabel)
  },
}

/** Tool calls without a thought also fall back to "Thinking". */
export const ThinkingFallbackWithTools: Story = {
  args: {
    messages: streamingToolMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "Read 1 file, 1 search" }),
    ).toBeVisible()
    await expect(
      canvas.getByRole("status", { name: "Thinking" }),
    ).toHaveTextContent("Thinking")
  },
}

const interimTextMessages: ChatMessage[] = [
  {
    id: "msg_interim_u1",
    role: "user",
    parts: [{ type: "text", content: "Merge the docker knowledge units." }],
  },
  {
    id: "msg_interim_a1",
    role: "assistant",
    parts: [
      { type: "thinking", content: "**Finding the units**\n\nList them." },
      {
        type: "tool-call",
        id: "tc_interim_1",
        name: "glob",
        input: { pattern: "knowledge/docker/**" },
      },
      { type: "text", content: "Let me check the setup guide." },
      {
        type: "tool-call",
        id: "tc_interim_2",
        name: "read",
        input: { filePath: "knowledge/docker/setup.md" },
      },
    ],
  },
]

/** Text in the middle of a run does not end it: the status line stays. */
export const InterimTextKeepsStatus: Story = {
  args: {
    messages: interimTextMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText("Let me check the setup guide."),
    ).toBeVisible()
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(1)
    await expect(statuses[0]).toHaveTextContent("Finding the units")
  },
}

/** The next turn gets its own status line; the done turn shows none. */
export const NextTurnShowsStatus: Story = {
  args: {
    messages: [
      ...progressDoneMessages,
      {
        id: "msg_next_u1",
        role: "user",
        parts: [{ type: "text", content: "Now commit it." }],
      },
      {
        id: "msg_next_a1",
        role: "assistant",
        parts: [
          {
            type: "thinking",
            content: "**Writing the commit**\n\nStage the file.",
          },
        ],
      },
    ],
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const statuses = canvas.getAllByRole("status")
    await expect(statuses).toHaveLength(1)
    await expect(statuses[0]).toHaveTextContent("Writing the commit")
    await expect(canvas.queryByText("Checking the git status")).toBeNull()
  },
}

/** After the reply, the current thought hides. The counters and the log stay. */
export const ChatProgressDone: Story = {
  tags: ["workspace-golden"],
  args: {
    messages: progressDoneMessages,
    status: "ready",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    await expect(log).toHaveAttribute("aria-expanded", "false")
    await expect(log).toHaveTextContent("Read 1 file")
    await expect(log).toHaveTextContent("3 thoughts")
    await expect(canvas.queryAllByRole("status")).toHaveLength(0)
    await expect(canvas.queryByText("Checking the git status")).toBeNull()
    await expect(
      canvas.getByText(/now in knowledge\/docker\/setup\.md/),
    ).toBeVisible()
  },
}

/** The open log lists each thought and each tool call with its details. */
export const ChatProgressLogExpanded: Story = {
  tags: ["workspace-golden"],
  args: {
    messages: progressDoneMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    await userEvent.click(log)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: progressCounters }),
      ).toHaveAttribute("aria-expanded", "true"),
    )
    const region = canvas.getByRole("region", { name: "Activity log" })
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: progressCounters }),
      ).toHaveAttribute("aria-controls", region.id),
    )
    await expect(log).not.toContainElement(region)
    const entries = within(region).getAllByRole("listitem")
    const texts = entries.map((entry) => entry.textContent ?? "")
    await expect(texts).toHaveLength(7)
    await expect(texts[0]).toContain("Inspecting knowledge units")
    await expect(texts[0]).toContain("split over five units")
    await expect(texts[1]).toContain("Consolidating docker knowledge")
    await expect(texts[2]).toContain("Checking the git status")
    await expect(texts[3]).toContain("Read file")
    await expect(texts[3]).toContain("knowledge/docker/setup.md")
    await expect(texts[4]).toContain("docker compose")
    await expect(texts[5]).toContain("docker knowledge units")
    await expect(texts[6]).toContain("Run command")
    await expect(texts[6]).toContain("git status --short")
    await expect(texts.join(" ")).not.toMatch(/\*\*/)
  },
}

/** The vertical space between two elements, in pixels. */
function gapBetween(upper: Element, lower: Element) {
  return Math.round(
    lower.getBoundingClientRect().top - upper.getBoundingClientRect().bottom,
  )
}

/**
 * The counters, the status line, and the log items have one gap. The tool
 * name is more prominent than its detail.
 */
export const ChatProgressSpacing: Story = {
  tags: ["workspace-golden"],
  args: {
    messages: progressWorkingMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    const status = canvas.getByRole("status")
    const gap = gapBetween(log, status)
    await expect(gap).toBe(8)
    await userEvent.click(log)
    const region = canvas.getByRole("region", { name: "Activity log" })
    const rows = within(region).getAllByRole("listitem")
    await expect(gapBetween(log, rows[0] as Element)).toBe(gap)
    await expect(gapBetween(rows[0] as Element, rows[1] as Element)).toBe(gap)
    await expect(gapBetween(rows.at(-1) as Element, status)).toBe(gap)
    const readRow = within(rows[3] as HTMLElement)
    const weight = (element: Element) =>
      Number(getComputedStyle(element).fontWeight)
    await expect(weight(readRow.getByText("Read file"))).toBeGreaterThan(
      weight(readRow.getByText("knowledge/docker/setup.md")),
    )
  },
}

const earlierTurns: ChatMessage[] = Array.from({ length: 4 }, (_, index) => [
  {
    id: `msg_scroll_u${index}`,
    role: "user" as const,
    parts: [{ type: "text" as const, content: `Question ${index + 1}` }],
  },
  {
    id: `msg_scroll_a${index}`,
    role: "assistant" as const,
    parts: [
      {
        type: "text" as const,
        content: Array.from(
          { length: 6 },
          () =>
            "The knowledge units describe the Docker setup, the compose file, and the local ports.",
        ).join(" "),
      },
    ],
  },
]).flat()

/**
 * At the bottom of a working turn, the thread stays at the bottom. Opening
 * the log does not scroll the thread: the counters stay in place.
 */
export const OpeningLogKeepsScroll: Story = {
  tags: ["workspace-golden"],
  args: {
    messages: [...earlierTurns, ...progressWorkingMessages],
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    const scroller = canvasElement.querySelector(
      '[role="log"] > div',
    ) as HTMLElement
    await expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight)
    await waitFor(() => {
      expect(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      ).toBeLessThan(2)
    })
    const top = log.getBoundingClientRect().top
    await userEvent.click(log)
    await waitFor(() =>
      expect(
        canvas.getByRole("button", { name: progressCounters }),
      ).toHaveAttribute("aria-expanded", "true"),
    )
    // The stick to the bottom scrolls in a smooth animation; wait past it.
    await new Promise((resolve) => setTimeout(resolve, 800))
    await expect(Math.round(log.getBoundingClientRect().top)).toBe(
      Math.round(top),
    )
  },
}

export const ReasoningCollapsed: Story = {
  args: {
    messages: reasoningMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("button", { name: "1 thought" }),
    ).toHaveAttribute("aria-expanded", "false")
    await expect(canvas.queryByText(/derived view/)).toBeNull()
  },
}

export const ThoughtsBetweenTools: Story = {
  args: {
    messages: thoughtsBetweenToolsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "Read 1 file, 1 search, 3 thoughts" }),
    )
    const region = canvas.getByRole("region", { name: "Activity log" })
    const texts = within(region)
      .getAllByRole("listitem")
      .map((entry) => entry.textContent ?? "")
    await expect(texts).toHaveLength(5)
    await expect(texts[0]).toContain("Reading the claim")
    await expect(texts[1]).toContain("ledger vs invoices")
    await expect(texts[2]).toContain("Comparing the files")
    await expect(texts[3]).toContain("knowledge/billing/ledger.md")
    await expect(texts[4]).toContain("Checking the answer")
  },
}

export const ToolUse: Story = {
  args: {
    messages: oneToolMessages,
  },
}

export const ToolUseMany: Story = {
  args: {
    messages: manyToolMessages,
  },
}

export const ReasoningAndTools: Story = {
  args: {
    messages: reasoningAndToolsMessages,
  },
}

/** A reopened conversation: the turn arrives as two assistant messages and must render as one. */
export const ReasoningAndToolsHydrated: Story = {
  args: {
    messages: hydratedReasoningAndToolsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getAllByRole("button", {
      name: "Read 1 file, 2 thoughts",
    })
    await expect(log).toHaveLength(1)
    await expect(log[0]).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.getByText(/ledger.md is the source of truth/),
    ).toBeVisible()
  },
}

const answerLinkMessages: ChatMessage[] = [
  {
    id: "msg_links_u1",
    role: "user",
    parts: [{ type: "text", content: "Where is the chat styling?" }],
  },
  {
    id: "msg_links_a1",
    role: "assistant",
    parts: [
      {
        type: "text",
        content: [
          "The answer styles are in `apps/ui/src/styles.css`. See also [the message component](apps/ui/src/components/ai-elements/message.tsx) and `package.json`.",
          "",
          "Streamdown renders the Markdown. Read the [Streamdown docs](https://streamdown.ai) for the options.",
          "",
          "These stay as code: `useState`, `process.env`, `Node.js`, `application/json`, `/etc/hosts`, `../outside.ts` and `pnpm dev`.",
        ].join("\n"),
      },
    ],
  },
]

/** In a workspace, file paths open the file. Text that is not clearly a path stays as code. */
export const AnswerLinksInWorkspace: Story = {
  args: {
    messages: answerLinkMessages,
    onOpenFile: fn(),
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "apps/ui/src/styles.css" }),
    )
    await expect(args.onOpenFile).toHaveBeenLastCalledWith(
      "apps/ui/src/styles.css",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "the message component" }),
    )
    await expect(args.onOpenFile).toHaveBeenLastCalledWith(
      "apps/ui/src/components/ai-elements/message.tsx",
    )
    await expect(
      canvas.getByRole("button", { name: "package.json" }),
    ).toBeVisible()
    // The off-site link keeps the Streamdown link-safety button and shows an icon.
    const external = canvas.getByRole("button", { name: "Streamdown docs" })
    await expect(external).toHaveAttribute("data-streamdown", "link")
    await expect(
      external.querySelector(".tabler-icon-external-link"),
    ).not.toBeNull()
    for (const text of [
      "useState",
      "process.env",
      "Node.js",
      "application/json",
      "/etc/hosts",
      "../outside.ts",
      "pnpm dev",
    ]) {
      await expect(canvas.queryByRole("button", { name: text })).toBeNull()
      await expect(canvas.getByText(text)).toBeVisible()
    }
    await expect(args.onOpenFile).toHaveBeenCalledTimes(2)
  },
}

/** Outside a workspace there is no file to open, so paths stay as code. */
export const AnswerLinksOutsideWorkspace: Story = {
  args: {
    messages: answerLinkMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(canvas.getByText("apps/ui/src/styles.css")).toBeVisible()
    await expect(
      canvas.queryByRole("button", { name: "apps/ui/src/styles.css" }),
    ).toBeNull()
    await expect(
      canvas.getByRole("button", { name: "Streamdown docs" }),
    ).toBeVisible()
  },
}

/** The user's bubble shows the typed text as it is: no link is blocked or rewritten. */
export const UserBubbleShowsTypedText: Story = {
  args: {
    messages: [
      {
        id: "msg_typed_u1",
        role: "user",
        parts: [
          {
            type: "text",
            content: "Check [the notes](docs/notes.md) and\nsee `a.ts`.",
          },
        ],
      },
    ],
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByText(/Check \[the notes\]\(docs\/notes\.md\) and/),
    ).toBeVisible()
    await expect(canvasElement.textContent).not.toContain("[blocked]")
  },
}

/** A turn ends with the changed-files card, then a push entry. The entry sits under the card and its long branch truncates. */
export const PushEntryUnderCard: Story = {
  tags: ["workspace-golden"],
  decorators: [
    (Story) => (
      <div
        data-testid="push-frame"
        className="flex h-[32rem] w-[26rem] bg-zinc-950"
      >
        <Story />
      </div>
    ),
  ],
  args: {
    messages: reasoningMessages,
    renderAfterMessage: (messageId) =>
      messageId === reasoningMessages[reasoningMessages.length - 1]?.id
        ? [
            <ConversationTurnChangesCard
              key="card"
              changes={{
                runId: "run_push_1",
                turn: 1,
                files: [
                  {
                    path: "knowledge/docker.md",
                    status: "added",
                    additions: 42,
                    deletions: 0,
                  },
                ],
              }}
              onOpenDiff={fn()}
            />,
            <ConversationSyncEntry
              key="sync"
              sync={{
                trigger: "create_pr",
                branch:
                  "ctxpipe/chat/conv_long_identifier_0123456789/12345678901234567890",
                sha: "8eb1704c2d1f0a5b6e3c9d7f4a2b1c0d9e8f7a6b",
                files: 1,
                treeUrl: "https://github.com/acme/docs/tree/branch",
                pullRequest: {
                  number: 27,
                  url: "https://github.com/acme/docs/pull/27",
                  opened: true,
                },
                turn: 1,
                syncedAt: "2026-08-16T10:05:00.000Z",
              }}
            />,
          ]
        : null,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const card = await canvas.findByRole("region", { name: "1 changed file" })
    const entry = await canvas.findByRole("region", {
      name: /^Pushed 1 file to/,
    })
    const frame = canvas.getByTestId("push-frame")
    // The entry sits under the card at a narrow and at a wide width.
    for (const width of ["26rem", "64rem"]) {
      frame.style.width = width
      await waitFor(() => {
        const cardBox = card.getBoundingClientRect()
        const entryBox = entry.getBoundingClientRect()
        expect(entryBox.top).toBeGreaterThanOrEqual(cardBox.bottom)
        expect(entryBox.left).toBeCloseTo(cardBox.left, 0)
        expect(entryBox.right).toBeLessThanOrEqual(cardBox.right + 1)
      })
    }
    // The long branch truncates at the narrow width.
    frame.style.width = "26rem"
    const branch = within(entry).getByText(/conv_long_identifier/)
    await waitFor(() =>
      expect(branch.scrollWidth).toBeGreaterThan(branch.clientWidth),
    )
  },
}
