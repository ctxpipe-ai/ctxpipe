import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  authConfigHandler,
  githubInstallationNoneHandler,
  organizationListWithOrgHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OrgHomePageContent } from "./$orgSlug.index"

const meta = {
  title: "Pages/Home",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Default: Story = {
  render: () => <OrgHomePageContent orgSlug="acme" />,
  parameters: {
    storyRoute: {
      pattern: "orgIndex",
      orgSlug: "acme",
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        authConfigHandler,
        sessionSignedInHandler({
          id: "user_storybook",
          onboardingCompletedAt: "2025-01-01T00:00:00.000Z",
        }),
        organizationListWithOrgHandler,
        githubInstallationNoneHandler,
      ],
    },
  },
}
