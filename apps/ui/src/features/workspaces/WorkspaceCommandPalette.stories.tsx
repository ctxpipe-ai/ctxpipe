import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn, userEvent, within } from "storybook/test"
import { workspaceListHandler } from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceCommandPalette } from "./WorkspaceCommandPalette"
import { docsWorkspace, readOnlyWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/CommandPalette",
  component: WorkspaceCommandPalette,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceListHandler([docsWorkspace, readOnlyWorkspace])],
      },
    },
  },
  args: {
    orgSlug: "acme",
    isOpen: true,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof WorkspaceCommandPalette>

export default meta

type Story = StoryObj<typeof meta>

export const Open: Story = {}

export const NoResults: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.type(
      canvas.getByPlaceholderText("Jump to…"),
      "zzzz-no-match",
    )
  },
}
