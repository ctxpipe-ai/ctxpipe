import type { Meta, StoryObj } from "@storybook/react-vite"
import { fn, userEvent, within } from "storybook/test"
import {
  githubInstallationReposHandler,
  workspaceListHandler,
} from "@/mocks/workspace-handlers"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceRepositoryPicker } from "./WorkspaceRepositoryPicker"
import { docsWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/RepositoryPicker",
  component: WorkspaceRepositoryPicker,
  decorators: [
    (Story) => (
      <div className="min-h-[24rem] w-full max-w-lg bg-zinc-950 px-6 py-10">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler(),
        ],
      },
    },
  },
  args: {
    orgSlug: "acme",
    submitLabel: "Create Workspace",
    onSubmit: fn(),
  },
} satisfies Meta<typeof WorkspaceRepositoryPicker>

export default meta

type Story = StoryObj<typeof meta>

export const PasteUrl: Story = {}

export const SelectGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /select github/i }),
    )
  },
}

export const SelectGitHubEmpty: Story = {
  parameters: {
    msw: {
      handlers: {
        page: [
          workspaceListHandler([docsWorkspace]),
          githubInstallationReposHandler([]),
        ],
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /select github/i }),
    )
  },
}

export const CreateOnGitHub: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement)
    await userEvent.click(
      canvas.getByRole("button", { name: /create on github/i }),
    )
  },
}

export const SaveError: Story = {
  args: {
    error: "That git URL is already used by another Workspace.",
  },
}
