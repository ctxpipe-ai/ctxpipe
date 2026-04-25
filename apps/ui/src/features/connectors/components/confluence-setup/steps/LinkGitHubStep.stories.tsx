import type { Meta, StoryObj } from "@storybook/react-vite"
import { entryPageInnerDecorators } from "../../../../../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../../../../../.storybook/decorators/with-story-route"
import { LinkGitHubStep } from "./LinkGitHubStep"

const orgSlug = "acme"

const meta = {
  title: "Components/Connections/Atlassian/Steps/LinkGitHub",
  component: LinkGitHubStep,
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "centered",
    storyRoute: {
      pattern: "orgIndex",
      orgSlug,
    } satisfies StoryRouteParams,
  },
} satisfies Meta<typeof LinkGitHubStep>

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => (
    <div className="w-full max-w-md p-2">
      <LinkGitHubStep orgSlug={orgSlug} />
    </div>
  ),
}
