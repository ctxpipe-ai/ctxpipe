import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../.storybook/decorators/with-story-route"
import { WorkspaceHydrateProgress } from "./WorkspaceHydrateProgress"
import { hydratingWorkspace } from "./workspace-fixtures"

const meta = {
  title: "Components/Workspaces/HydrateProgress",
  component: WorkspaceHydrateProgress,
  decorators: [
    (Story) => (
      <div className="flex min-h-[24rem] bg-zinc-950">
        <Story />
      </div>
    ),
    ...entryPageInnerDecorators,
  ],
  parameters: {
    layout: "fullscreen",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
  args: { workspace: hydratingWorkspace },
} satisfies Meta<typeof WorkspaceHydrateProgress>

export default meta

type Story = StoryObj<typeof meta>

export const Hydrating: Story = {}

export const WaitingForTip: Story = {
  args: {
    workspace: { ...hydratingWorkspace, desiredSha: null },
  },
}
