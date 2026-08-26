import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, userEvent, within } from "storybook/test"
import type { ChatMessage } from "@/features/chat/types"
import {
  docsConversationDetail,
  manyToolMessages,
  oneToolMessages,
  reasoningAndToolsMessages,
  reasoningMessages,
  streamingReasoningAndToolsMessages,
  streamingReasoningMessages,
  streamingToolMessages,
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
    await userEvent.click(canvas.getByRole("button", { name: /reasoning/i }))
  },
}

export const ReasoningLive: Story = {
  args: {
    messages: streamingReasoningMessages,
    status: "streaming",
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
