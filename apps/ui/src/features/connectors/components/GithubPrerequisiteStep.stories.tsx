import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GithubPrerequisiteStep } from "./GithubPrerequisiteStep"

const meta = {
  title: "Components/Connections/GitHubPrerequisiteStep",
  component: GithubPrerequisiteStep,
  decorators: entryPageInnerDecorators,
  args: { orgSlug: "acme", sourceName: "Linear" },
  parameters: {
    storyRoute: {
      pattern: "orgConnectors",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof GithubPrerequisiteStep>

export default meta

type Story = StoryObj<typeof meta>

export const Required: Story = {}
