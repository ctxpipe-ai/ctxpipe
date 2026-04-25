import type { Meta, StoryObj } from "@storybook/react-vite"
import {
  authConfigHandler,
  organizationListEmptyHandler,
  sessionSignedInHandler,
} from "@/mocks/handlers"
import { entryPageInnerDecorators } from "../../.storybook/decorators/entry-page-decorators"
import type { StoryRouteParams } from "../../.storybook/decorators/with-story-route"
import { OnboardingPageContent } from "./onboarding"

const meta = {
  title: "Pages/Onboarding",
  decorators: entryPageInnerDecorators,
  parameters: {
    layout: "fullscreen",
  },
} satisfies Meta

export default meta

type Story = StoryObj<typeof meta>

export const Start: Story = {
  render: () => <OnboardingPageContent urlOrgSlug={null} />,
  parameters: {
    storyRoute: {
      pattern: "flat",
      path: "/onboarding",
    } satisfies StoryRouteParams,
    msw: {
      handlers: [
        authConfigHandler,
        sessionSignedInHandler({
          id: "user_storybook",
          onboardingCompletedAt: null,
        }),
        organizationListEmptyHandler,
      ],
    },
  },
}
