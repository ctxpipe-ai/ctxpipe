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

/**
 * Step of the Slack setup dialog that asks the admin to connect GitHub first,
 * because ctxpipe writes the saved threads to a Workspace repository on GitHub.
 */
export const Slack: Story = {
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
