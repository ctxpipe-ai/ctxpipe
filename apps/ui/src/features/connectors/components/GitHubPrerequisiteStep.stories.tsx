import type { Meta, StoryObj } from "@storybook/react-vite"

import { githubAppMissingHandlers, signedInHandlers } from "@/mocks/handlers"

import type { StoryRouteParams } from "../../../../.storybook/decorators/with-story-route"
import { GitHubPrerequisiteStep } from "./GitHubPrerequisiteStep"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/GitHubPrerequisiteStep",
  component: GitHubPrerequisiteStep,
  parameters: {
    app: "root",
    queryClient: true,
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
    review: { kind: "component" },
    msw: {
      handlers: { session: signedInHandlers, github: githubAppMissingHandlers },
    },
  },
} satisfies Meta<typeof GitHubPrerequisiteStep>

export default meta

type Story = StoryObj<typeof meta>

export const Slack: Story = {
  parameters: {
    review: {
      purpose:
        "Setup step that asks the user to connect GitHub before a source connector: the user sets up Slack.",
    },
  },
  args: {
    orgSlug,
    sourceName: "Slack",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
}

export const Notion: Story = {
  parameters: {
    review: {
      purpose:
        "Setup step that asks the user to connect GitHub before a source connector: the user sets up Notion.",
    },
  },
  args: {
    orgSlug,
    sourceName: "Notion",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
}

export const Confluence: Story = {
  parameters: {
    review: {
      purpose:
        "Setup step that asks the user to connect GitHub before a source connector: the user sets up Confluence.",
    },
  },
  args: {
    orgSlug,
    sourceName: "Confluence",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
}

export const Linear: Story = {
  parameters: {
    review: {
      purpose:
        "Setup step that asks the user to connect GitHub before a source connector: the user sets up Linear.",
    },
  },
  args: {
    orgSlug,
    sourceName: "Linear",
  },
  render: (args) => (
    <div className="w-full max-w-xl p-2">
      <GitHubPrerequisiteStep {...args} />
    </div>
  ),
}
