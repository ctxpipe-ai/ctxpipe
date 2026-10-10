import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import type { ChatMessage } from "@/features/chat/types"
import {
  docsConversationDetail,
  hydratedReasoningAndToolsMessages,
  manyToolMessages,
  oneToolMessages,
  reasoningAndToolsMessages,
  reasoningMessages,
  severalThoughtsMessages,
  streamingReasoningAndToolsMessages,
  streamingReasoningMessages,
  streamingSeveralThoughtsMessages,
  streamingToolMessages,
  thoughtsBetweenToolsMessages,
} from "@/features/workspaces/workspace-fixtures"
import { ConversationThread, WORKING_VERBS } from "./ConversationThread"

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

export const ReplyOnly: Story = {}

export const ReasoningCollapsed: Story = {
  args: {
    messages: reasoningMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const reasoning = canvas.getByRole("button", { name: /reasoning/i })
    await expect(reasoning).toHaveAttribute("aria-expanded", "false")
    await expect(reasoning).toHaveTextContent("Inspecting repository options")
    await expect(reasoning.textContent ?? "").not.toMatch(/\*\*Inspecting/)
  },
}

export const ReasoningExpanded: Story = {
  args: {
    messages: reasoningMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const reasoning = canvas.getByRole("button", { name: /reasoning/i })
    await userEvent.click(reasoning)
    await expect(reasoning).toHaveAttribute("aria-expanded", "true")
    const region = canvas.getByRole("region", { name: "Reasoning" })
    await expect(reasoning).not.toContainElement(region)
    await expect(region).toHaveTextContent("derived view")
  },
}

const workingVerb = new RegExp(
  WORKING_VERBS.map((verb) => verb.replace("…", "")).join("|"),
)

export const ReasoningLive: Story = {
  args: {
    messages: streamingReasoningMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const live = canvas.getByRole("status", { name: /reasoning/i })
    // A working verb, the latest heading, and no reasoning body while live.
    await expect(live).toHaveTextContent(workingVerb)
    await expect(live).toHaveTextContent("Consolidating documents")
    await expect(live).not.toHaveTextContent("Editing docker.md")
    await expect(live).not.toHaveTextContent("Implementing document updates")
  },
}

export const ThoughtsCollapsed: Story = {
  args: {
    messages: severalThoughtsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const group = canvas.getByRole("button", { name: "Thought 2x" })
    await expect(group).toHaveAttribute("aria-expanded", "false")
    await expect(group).toHaveTextContent("Thought 2x")
    await expect(
      canvas.getByRole("button", { name: /reasoning/i }),
    ).toHaveTextContent("Checking the answer")
    await expect(canvas.queryByText(/Reading the claim/)).toBeNull()
  },
}

export const ThoughtsExpanded: Story = {
  args: {
    messages: severalThoughtsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const group = canvas.getByRole("button", { name: "Thought 2x" })
    await userEvent.click(group)
    await expect(group).toHaveAttribute("aria-expanded", "true")
    const region = canvas.getByRole("region", { name: "Thought 2x" })
    await expect(group).toHaveAttribute("aria-controls", region.id)
    await expect(group).not.toContainElement(region)
    await expect(region).toHaveTextContent("Reading the claim")
    await expect(region).toHaveTextContent("Comparing the files")
    await expect(region).not.toHaveTextContent("Checking the answer")
  },
}

export const ThoughtsBetweenTools: Story = {
  args: {
    messages: thoughtsBetweenToolsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const tools = canvas.getByRole("button", { name: "Read 1 file, 1 search" })
    const group = canvas.getByRole("button", { name: "Thought 2x" })
    const latest = canvas.getByRole("button", { name: /reasoning/i })
    await expect(
      tools.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await expect(
      group.compareDocumentPosition(latest) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    await expect(latest).toHaveTextContent("Checking the answer")
  },
}

export const ThoughtsLive: Story = {
  args: {
    messages: streamingSeveralThoughtsMessages,
    status: "streaming",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const live = canvas.getByRole("status", { name: /reasoning/i })
    await expect(live).toHaveTextContent("Checking the answer")
    await expect(live).not.toHaveTextContent("Reading the claim")
    await expect(
      canvas.getByRole("button", { name: "Thought 2x" }),
    ).toHaveAttribute("aria-expanded", "false")
  },
}

export const ToolUse: Story = {
  args: {
    messages: oneToolMessages,
  },
}

export const ToolUseExpanded: Story = {
  args: {
    messages: manyToolMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /read 1 file, 2 searches/i }),
    )
  },
}

export const ToolUseMany: Story = {
  args: {
    messages: manyToolMessages,
  },
}

export const ToolUseLive: Story = {
  args: {
    messages: streamingToolMessages,
    status: "streaming",
  },
}

export const ReasoningAndTools: Story = {
  args: {
    messages: reasoningAndToolsMessages,
  },
}

export const ReasoningAndToolsLive: Story = {
  args: {
    messages: streamingReasoningAndToolsMessages,
    status: "streaming",
  },
}

/** A reopened conversation: the turn arrives as two assistant messages and must render as one. */
export const ReasoningAndToolsHydrated: Story = {
  args: {
    messages: hydratedReasoningAndToolsMessages,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    const reasoning = canvas.getAllByRole("button", { name: /reasoning/i })
    await expect(reasoning).toHaveLength(1)
    await expect(reasoning[0]).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.getByRole("button", { name: /read 1 file/i }),
    ).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.getByRole("button", { name: "Thought" }),
    ).toHaveAttribute("aria-expanded", "false")
    await expect(
      canvas.getByText(/ledger.md is the source of truth/),
    ).toBeVisible()
  },
}

export const Waiting: Story = {
  args: {
    messages: [
      {
        id: "msg_wait_u1",
        role: "user",
        parts: [{ type: "text", content: "What's in this Workspace?" }],
      } satisfies ChatMessage,
    ],
    status: "submitted",
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await expect(
      canvas.getByRole("status", { name: "Working" }),
    ).toHaveTextContent(workingVerb)
  },
}

export const SettingUpSandbox: Story = {
  args: {
    messages: [
      {
        id: "msg_setup_u1",
        role: "user",
        parts: [{ type: "text", content: "What's in this Workspace?" }],
      } satisfies ChatMessage,
    ],
    status: "submitted",
    waitLabel: "Setting up sandbox",
  },
}
