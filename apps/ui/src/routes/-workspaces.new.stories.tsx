import type { Meta, StoryObj } from "@storybook/react-vite"
import { userEvent, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import {
  NewWorkspacePageContent,
  NewWorkspaceSessionFallback,
} from "./$orgSlug.workspaces.new"

const orgSlug = "acme"

const meta = {
  title: "Pages/Workspaces/New",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgWorkspaceNew",
      orgSlug,
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [workspaceListHandler([]), githubInstallationReposHandler()],
      },
    },
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Loading: Story = {
  render: () => <NewWorkspaceSessionFallback />,
}

export const PasteUrl: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(canvas.getByRole("tab", { name: /paste url/i }))
  },
}

export const SelectGitHub: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await canvas.findByRole("list", { name: /repositories/i })
  },
}

export const CreateOnGitHub: Story = {
  render: () => <NewWorkspacePageContent orgSlug={orgSlug} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("tab", { name: /create on github/i }),
    )
  },
}
