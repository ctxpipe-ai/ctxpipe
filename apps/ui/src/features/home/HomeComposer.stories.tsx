import type { Meta, StoryObj } from "@storybook/react-vite"
import { http } from "msw"
import { StrictMode } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import { conversationPostPath } from "@/mocks/conversation-agui"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { HomeComposer } from "./HomeComposer"

const composerPosts = { count: 0 }

const meta = {
  title: "Components/Home/Composer",
  component: HomeComposer,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "padded",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: {
    orgSlug: "acme",
    workspaces: [docsWorkspace, readOnlyWorkspace],
    selected: docsWorkspace,
    onSelectWorkspace: () => undefined,
  },
} satisfies Meta<typeof HomeComposer>

export default meta

type Story = StoryObj<typeof meta>

export const WithWorkspaces: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByLabelText("Select workspace"))
    const page = within(canvasElement.ownerDocument.body)
    const menu = await page.findByRole("menu", { name: "Workspaces" })
    expect(menu.className).toMatch(/rounded-md/)
  },
}

export const NoWorkspaces: Story = {
  args: {
    workspaces: [],
    selected: null,
  },
}

/**
 * The composer opens the new conversation and hands it the first message.
 * The conversation sends it on its own chat stream, so the composer itself
 * sends nothing.
 */
export const FirstMessageOpensConversation: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () => {
            composerPosts.count += 1
            return new Response(null, { status: 500 })
          }),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    composerPosts.count = 0
    const canvas = within(canvasElement)
    await userEvent.type(
      await canvas.findByPlaceholderText(/ask about this workspace/i),
      "What changed this week?",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() =>
      expect(
        canvas.queryByPlaceholderText(/ask about this workspace/i),
      ).toBeNull(),
    )
    expect(composerPosts.count).toBe(0)
  },
}

export const FirstMessageOpensConversationInStrictMode: Story = {
  tags: ["workspace-golden"],
  decorators: [
    (Story) => (
      <StrictMode>
        <Story />
      </StrictMode>
    ),
  ],
  parameters: FirstMessageOpensConversation.parameters,
  play: FirstMessageOpensConversation.play,
}
