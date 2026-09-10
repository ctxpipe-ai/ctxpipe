import type { Meta, StoryObj } from "@storybook/react-vite"
import { http } from "msw"
import { expect, userEvent, waitFor, within } from "storybook/test"
import {
  docsWorkspace,
  readOnlyWorkspace,
} from "@/features/workspaces/workspace-fixtures"
import {
  conversationAguiSseResponse,
  conversationAguiTextEvents,
  conversationPostPath,
} from "@/mocks/conversation-agui"
import { workspaceShellHandlers } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { HomeComposer } from "./HomeComposer"

const firstMessagePosts = { count: 0 }

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

export const FirstMessageSendsOnce: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          http.post(conversationPostPath, () => {
            firstMessagePosts.count += 1
            return conversationAguiSseResponse(
              conversationAguiTextEvents({
                threadId: "conv_home",
                messageId: "msg_home",
                text: "Native reply completed.",
              }),
            )
          }),
          ...workspaceShellHandlers(),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    firstMessagePosts.count = 0
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText(/ask about this workspace/i),
      "What changed this week?",
    )
    await userEvent.click(canvas.getByRole("button", { name: /send/i }))
    await waitFor(() => expect(firstMessagePosts.count).toBe(1))
    await waitFor(() =>
      expect(
        canvas.queryByPlaceholderText(/ask about this workspace/i),
      ).toBeNull(),
    )
  },
}
