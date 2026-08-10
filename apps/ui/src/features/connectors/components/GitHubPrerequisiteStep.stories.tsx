import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/GitHubPrerequisiteStep",
  component: GitHubPrerequisiteStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof GitHubPrerequisiteStep>

export default meta

type Story = StoryObj<typeof meta>

export const Notion: Story = {
  render: () => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep orgSlug={orgSlug} sourceName="Notion" />
    </div>
  ),
}

export const Confluence: Story = {
  render: () => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep orgSlug={orgSlug} sourceName="Confluence" />
    </div>
  ),
}
