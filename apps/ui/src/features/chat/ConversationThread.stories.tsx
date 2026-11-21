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
import { createTreeFileResolver } from "@/lib/workspace-file-path"

import preview from "../../../.storybook/preview"
import { ConversationThread } from "./ConversationThread"

const meta = preview.meta({
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
    review: { kind: "component" },
    layout: "fullscreen",
  },
  args: {
    messages: docsConversationDetail.messages,
    error: null,
    status: "ready",
  },
})

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

/**
 * Chat thread of a Workspace conversation: a finished billing question and its
 * plain text answer, with no tool calls.
 */
export const ReplyOnly = meta.story()

/**
 * Chat thread while the agent works on a request: the closed activity row
 * counts the reads, searches, tools and thoughts. One status line names the
 * current thought by its title only.
 */
export const WorkingWithThought = meta.story({
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
})

/**
 * Chat thread right after the user asks, before any activity: the status line
 * gives the real sandbox state and says that ctxpipe sets up the sandbox.
 */
export const SettingUpSandbox = meta.story({
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
})

/**
 * Chat thread right after the user asks: no thought or system state is
 * available yet, so the status line falls back to Thinking.
 */
export const ThinkingFallback = meta.story({
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
})

/**
 * Chat thread while tools run without a thought: the log counts the file read
 * and the search, and the status line falls back to Thinking.
 */
export const ThinkingFallbackWithTools = meta.story({
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
})

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

/**
 * Chat thread while the agent works: interim reply text shows, and the status
 * line still names the current thought. Text in the middle of a run does not
 * end the run.
 */
export const InterimTextKeepsStatus = meta.story({
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
})

/**
 * Chat thread with a finished turn and a new working turn: only the new turn
 * has its own status line. The finished turn shows none.
 */
export const NextTurnShowsStatus = meta.story({
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
})

/**
 * Chat thread after the reply: the activity log stays closed with its counters
 * and the answer shows. The current thought hides, so no status line shows.
 */
export const ChatProgressDone = meta.story({
  parameters: {
    intent:
      "Catches a finished chat turn that shows a live status or an open activity log. The log stays closed with counts and the answer is visible. Not for log entries.",
  },
  tags: ["required"],
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
})

/**
 * Chat thread of a finished turn with the activity log open: each thought and
 * each tool call is a row with its details.
 */
export const ChatProgressLogExpanded = meta.story({
  parameters: {
    intent:
      "Catches an open activity log that misses a thought or tool call, or shows raw markdown. Each entry shows its details. Not for spacing or the closed state.",
  },
  tags: ["required"],
  args: {
    messages: progressDoneMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const log = canvas.getByRole("button", { name: progressCounters })
    await userEvent.click(log)
    await waitFor(() => expect(log).toHaveAttribute("aria-expanded", "true"))
    const region = canvas.getByRole("region", { name: "Activity log" })
    await waitFor(() => expect(log).toHaveAttribute("aria-controls", region.id))
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
})

/** The vertical space between two elements, in pixels. */
function gapBetween(upper: Element, lower: Element) {
  return Math.round(
    lower.getBoundingClientRect().top - upper.getBoundingClientRect().bottom,
  )
}

/**
 * Chat thread while the agent works, with the activity log open: the log
 * button, the rows and the status line have equal gaps. The tool name is more
 * prominent than its detail.
 */
export const ChatProgressSpacing = meta.story({
  parameters: {
    intent:
      "Catches uneven gaps between the activity log button, its rows, and the live status. Tool names must stay bolder than their details. Not for log content.",
  },
  tags: ["required"],
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
})

/** Three earlier turns about the Docker setup, long enough to scroll. */
const earlierTurns: ChatMessage[] = (
  [
    [
      "Where is the local Docker setup described?",
      "The knowledge unit knowledge/dev/docker.md describes the local setup. It lists the services of docker-compose.yml: Postgres on port 5433, FalkorDB on port 6379, and the OpenTelemetry collector on port 4318. It also says that `pnpm dev:infra` starts these services and that `pnpm dev` starts the backend and the UI on the host.",
    ],
    [
      "Which profile starts the production images?",
      "The deploy profile starts the production images. Run `pnpm start` to use it. The infra profile starts only the databases and the collector, so you run the backend and the UI on the host. Two more units, knowledge/dev/compose-profiles.md and knowledge/ops/deploy.md, repeat parts of this text with older port numbers.",
    ],
    [
      "Are the older port numbers still used anywhere?",
      "No. The compose file uses port 5433 for Postgres since the change to parallel worktrees. The older units still name port 5432. They also describe a database per developer, which the setup no longer uses: each linked worktree now gets its own database on the shared Postgres.",
    ],
  ] satisfies [string, string][]
).flatMap(([question, answer], index) => [
  {
    id: `msg_scroll_u${index}`,
    role: "user" as const,
    parts: [{ type: "text" as const, content: question }],
  },
  {
    id: `msg_scroll_a${index}`,
    role: "assistant" as const,
    parts: [{ type: "text" as const, content: answer }],
  },
])

/**
 * Chat thread of a Workspace, scrolled to the bottom of a turn that still
 * works: the user opened its activity log. The thread stays at the bottom, and
 * the counter row keeps its place while the log opens below it.
 */
export const OpeningLogKeepsScroll = meta.story({
  parameters: {
    intent:
      "Catches an activity log that moves the chat when the user opens it. The thread stays at the bottom and the log button keeps its place. Not for log content.",
  },
  // The runner turns on reduced motion for this tag, so the thread jumps to
  // the bottom at once and no spring scroll runs.
  tags: ["required", "reduced-motion"],
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
      // The thread keeps within a few pixels of the bottom.
      expect(
        scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight,
      ).toBeLessThan(4)
    })
    // StickToBottom does not scroll at once after a change of height. The
    // browser measures the new height in the next frame, and StickToBottom
    // scrolls in the frame after that. Three frames hold that scroll.
    const threeFrames = async () => {
      for (let frame = 0; frame < 3; frame++)
        await new Promise((next) => requestAnimationFrame(next))
    }
    // The web fonts change the height of the text.
    await document.fonts.ready
    await threeFrames()
    const top = log.getBoundingClientRect().top
    await userEvent.click(log)
    await canvas.findByRole("region", { name: "Activity log" })
    // A wait for the old place passed before the scroll, also with no
    // stopScroll() (CTX-1437). Thus the play lets the frames of the scroll
    // pass, and then the counters must be in their old place.
    await threeFrames()
    await expect(
      canvas
        .getByRole("button", { name: progressCounters })
        .getBoundingClientRect().top,
    ).toBe(top)
  },
})

/**
 * Chat thread of a Workspace with an answer after one thought: the activity row
 * with its chevron is closed, so the thought text stays hidden until the user
 * opens it.
 */
export const ReasoningCollapsed = meta.story({
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
})

/**
 * Chat thread of a turn with thoughts between tool calls: the open activity log
 * lists the five entries in order.
 */
export const ThoughtsBetweenTools = meta.story({
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
})

/** Chat thread of a turn where the agent used one tool before it answered. */
export const ToolUse = meta.story({
  args: {
    messages: oneToolMessages,
  },
})

/** Chat thread of a turn where the agent used many tools before it answered. */
export const ToolUseMany = meta.story({
  args: {
    messages: manyToolMessages,
  },
})

/** Chat thread of a turn with thoughts and tool calls before the answer. */
export const ReasoningAndTools = meta.story({
  args: {
    messages: reasoningAndToolsMessages,
  },
})

/**
 * Chat thread of a reopened conversation: the server stores one turn as two
 * assistant messages, and the thread shows them as one turn with one activity
 * log.
 */
export const ReasoningAndToolsHydrated = meta.story({
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
})

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
          "Line anchors: [`knowledge/x.md`](knowledge/x.md#L12), [`knowledge/y.md`](knowledge/y.md#L12-L20), [`knowledge/z.md`](knowledge/z.md:12) and [`knowledge/w.md`](file:///workspace/knowledge/w.md).",
          "",
          "These stay as code: `useState`, `process.env`, `Node.js`, `application/json`, `/etc/hosts`, `../outside.ts` and `pnpm dev`.",
        ].join("\n"),
      },
    ],
  },
]

/**
 * Chat answer in a Workspace: file paths are buttons that open the file, and a
 * web link has an icon. Text that is not clearly a path stays as code.
 */
export const AnswerLinksInWorkspace = meta.story({
  args: {
    messages: answerLinkMessages,
    fileLinks: {
      resolve: createTreeFileResolver([
        "apps/ui/src/styles.css",
        "apps/ui/src/components/ai-elements/message.tsx",
        "package.json",
        "knowledge/x.md",
        "knowledge/y.md",
        "knowledge/z.md",
        "knowledge/w.md",
      ]),
      open: fn(),
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "apps/ui/src/styles.css" }),
    )
    await expect(args.fileLinks?.open).toHaveBeenLastCalledWith(
      "apps/ui/src/styles.css",
    )
    await userEvent.click(
      canvas.getByRole("button", { name: "the message component" }),
    )
    await expect(args.fileLinks?.open).toHaveBeenLastCalledWith(
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
    for (const path of [
      "knowledge/x.md",
      "knowledge/y.md",
      "knowledge/z.md",
      "knowledge/w.md",
    ]) {
      await userEvent.click(canvas.getByRole("button", { name: path }))
      await expect(args.fileLinks?.open).toHaveBeenLastCalledWith(path)
    }
    await expect(canvas.queryByText(/blocked/)).toBeNull()
    await expect(args.fileLinks?.open).toHaveBeenCalledTimes(6)
  },
})

/**
 * Chat answer outside a Workspace: file paths stay as code because there is no
 * file to open.
 */
export const AnswerLinksOutsideWorkspace = meta.story({
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
})

/**
 * Chat thread with one user message: the bubble keeps the typed Markdown text
 * as it is. No link is blocked or rewritten.
 */
export const UserBubbleShowsTypedText = meta.story({
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
})

/**
 * Chat turn in a narrow frame: the turn ends with the changed-files card, and
 * under it the push entry. The long branch name of the entry truncates.
 */
export const PushEntryUnderCard = meta.story({
  parameters: {
    intent:
      "Catches a push entry that sits beside or outside the changes card, or whose long branch name does not truncate. Not for card content or push data.",
  },
  tags: ["required"],
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
    await document.fonts.ready
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
})

/**
 * Chat answer in a Workspace with its git file tree: a bare file name that is
 * in the tree opens that file, and a name that is not in the tree stays text.
 */
export const AnswerLinksWithTree = meta.story({
  args: {
    messages: [
      {
        id: "msg_links_tree",
        role: "assistant",
        parts: [
          {
            type: "text",
            content: "Read `anthropic-2.md`, then `missing.md`.",
          },
        ],
      },
    ],
    fileLinks: {
      resolve: createTreeFileResolver([
        "knowledge/apis/anthropic.md",
        "knowledge/apis/anthropic-2.md",
      ]),
      open: fn(),
    },
  },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: "anthropic-2.md" }),
    )
    await expect(args.fileLinks?.open).toHaveBeenLastCalledWith(
      "knowledge/apis/anthropic-2.md",
    )
    await expect(
      canvas.queryByRole("button", { name: "missing.md" }),
    ).toBeNull()
    await expect(canvas.getByText("missing.md")).toBeVisible()
  },
})
